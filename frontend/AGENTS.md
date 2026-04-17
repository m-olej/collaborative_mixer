# Cloud DAW — Frontend Agent Guide

> React 19 + TypeScript SPA. Read root `AGENTS.md` first for cross-cutting concerns.
> Run `npm run lint && npm run build` to validate work before finishing.

---

## 1. Technology Stack

| Technology       | Version     | Role                                                      |
|------------------|-------------|-----------------------------------------------------------|
| React            | ^19.2.4     | UI component tree, slow state (metadata, track list)      |
| TypeScript       | ~6.0.2      | Mandatory for all source files                            |
| Vite             | ^8.0.4      | Dev server + production bundler                           |
| Tailwind CSS     | ^4.2.2      | All styling (via `@tailwindcss/vite` plugin)              |
| Zustand          | ^5.0.12     | Global state outside React lifecycle (socket, channel)    |
| React Router DOM | ^7.14.1     | Client-side routing                                       |
| phoenix (JS)     | ^1.8.5      | Phoenix Channel WebSocket client                          |
| lucide-react     | ^1.8.0      | Icon set                                                  |

---

## 2. Project Structure

```
frontend/
├── AGENTS.md
├── index.html
├── vite.config.ts          ← plugins: react(), tailwindcss()
├── package.json
├── tsconfig.app.json       ← strict TS config for src/
└── src/
    ├── main.tsx            ← React root, Router provider
    ├── App.tsx             ← Top-level route layout (currently placeholder)
    ├── App.css / index.css ← Base global styles (minimal; prefer Tailwind)
    └── assets/             ← Static images, SVGs
```

**Planned structure to build:**

```
src/
├── store/
│   ├── useSocketStore.ts      ← Zustand: Phoenix socket + channel instances
│   └── useProjectStore.ts     ← Zustand: project metadata, track list
├── hooks/
│   ├── useChannel.ts          ← Connect/join Phoenix channel
│   └── useAudioWorklet.ts     ← AudioContext + AudioWorklet lifecycle
├── workers/
│   └── audio-processor.ts     ← AudioWorkletProcessor (runs in audio thread)
├── components/
│   ├── Mixer/
│   │   ├── MixerLayout.tsx
│   │   ├── TrackStrip.tsx     ← Volume fader, mute, EQ controls
│   │   └── MasterBus.tsx
│   ├── Visualizer/
│   │   └── SpectrumCanvas.tsx ← Canvas FFT drawing
│   ├── Transport/
│   │   └── TransportBar.tsx   ← Play/Stop, BPM, playhead position
│   └── Library/
│       └── SampleBrowser.tsx  ← REST: paginated /api/samples
├── api/
│   └── rest.ts               ← Typed fetch wrappers for REST endpoints
└── types/
    └── daw.ts                ← Shared TypeScript types
```

---

## 3. CRITICAL: Real-Time Rendering Rule (useRef vs useState)

This is the most important performance rule in the codebase.

### FORBIDDEN — causes frame drops and audio glitches

```tsx
// ❌ NEVER use useState for data arriving at > 10 Hz
const [volume, setVolume] = useState(0);
channel.on("audio_update", (data) => setVolume(data.vol)); // triggers reconciliation
```

### REQUIRED — bypass Virtual DOM entirely

```tsx
// ✅ ALWAYS use useRef + direct DOM mutation for real-time data
const volumeBarRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  channel.on("audio_update", (data) => {
    if (volumeBarRef.current) {
      volumeBarRef.current.style.height = `${data.vol * 100}%`;
    }
  });
}, [channel]);

return <div ref={volumeBarRef} className="volume-bar" />;
```

### What to use `useRef` for (all real-time)

- Volume meter / VU meter bar heights
- Playhead position (CSS `left` or `transform: translateX`)
- FFT/spectrum canvas drawing
- Any value updated from WebSocket binary frame handler

### What to use `useState` / Zustand for (slow state)

- Project name, BPM, track list structure
- UI modals open/close
- Sample library pagination cursor
- Network connection status

---

## 4. Web Audio API: AudioWorklet

All audio playback MUST happen in an `AudioWorkletProcessor` running in the dedicated audio thread. Direct `AudioContext.createScriptProcessor` is deprecated and runs on the main thread — do not use it.

### Architecture

```
WebSocket binary frame arrives
        ↓
Main thread: extract Float32Array from frame offset 516
        ↓
postMessage → SharedArrayBuffer (ring buffer) OR MessagePort to AudioWorklet
        ↓
AudioWorkletProcessor.process() fills output buffers from ring buffer
        ↓
Audio output
```

### AudioWorklet registration

```ts
// In useAudioWorklet.ts
const ctx = new AudioContext({ sampleRate: 44100 });
await ctx.audioWorklet.addModule('/audio-processor.js');
const node = new AudioWorkletNode(ctx, 'cloud-daw-processor');
node.connect(ctx.destination);
```

### AudioWorkletProcessor (workers/audio-processor.ts)

```ts
// This file runs in AudioWorkletGlobalScope — no DOM access, no fetch, no imports
class CloudDawProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array[] = [];

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // Dequeue from ring buffer and fill outputs[0][0]
    return true; // keep alive
  }
}
registerProcessor('cloud-daw-processor', CloudDawProcessor);
```

**Rules:**
- `audio-processor.ts` must be compiled separately and served as a static file from `public/`.
- No React, no Zustand, no imports from `node_modules` in the worklet file.
- Communicate from main thread to worklet only via `node.port.postMessage()` or `SharedArrayBuffer`.

---

## 5. Canvas API: FFT Spectrum Visualizer

The FFT data arrives as `Uint8Array(512)` from bytes 4–515 of each binary frame.

```tsx
// components/Visualizer/SpectrumCanvas.tsx
const canvasRef = useRef<HTMLCanvasElement>(null);
const animFrameRef = useRef<number>(0);
const fftDataRef = useRef<Uint8Array>(new Uint8Array(512));

// Called from WebSocket handler — no state, just update the ref
function onAudioFrame(buffer: ArrayBuffer) {
  fftDataRef.current = new Uint8Array(buffer, 4, 512);
}

// Draw loop — never driven by React re-renders
function draw() {
  const canvas = canvasRef.current;
  if (!canvas) return;
  const ctx = canvas.getContext('2d')!;
  const data = fftDataRef.current;
  const W = canvas.width, H = canvas.height;
  const barWidth = W / data.length;

  ctx.clearRect(0, 0, W, H);
  data.forEach((val, i) => {
    const barH = (val / 255) * H;
    ctx.fillStyle = `hsl(${(i / data.length) * 240}, 80%, 60%)`;
    ctx.fillRect(i * barWidth, H - barH, barWidth - 1, barH);
  });

  animFrameRef.current = requestAnimationFrame(draw);
}

useEffect(() => {
  animFrameRef.current = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(animFrameRef.current);
}, []);
```

---

## 6. Phoenix Channel Integration

Use the `phoenix` npm package (`@types/phoenix` for types).

### Zustand store (store/useSocketStore.ts)

```ts
import { Socket, Channel } from 'phoenix';
import { create } from 'zustand';

interface SocketStore {
  socket: Socket | null;
  channel: Channel | null;
  connect: (projectId: string) => void;
  disconnect: () => void;
}

export const useSocketStore = create<SocketStore>((set, get) => ({
  socket: null,
  channel: null,
  connect: (projectId) => {
    const socket = new Socket('/socket', {});
    socket.connect();
    const channel = socket.channel(`project:${projectId}`, {});
    channel.join()
      .receive('ok', (initState) => { /* populate slow state */ })
      .receive('error', console.error);
    set({ socket, channel });
  },
  disconnect: () => {
    get().socket?.disconnect();
    set({ socket: null, channel: null });
  },
}));
```

### Binary message handling

```ts
channel.onMessage = (event, payload, ref) => {
  if (payload?.constructor === ArrayBuffer) {
    const msgType = new Uint8Array(payload)[0]; // byte 0 = message type
    if (msgType === 1) handleAudioFrame(payload);
  }
  return payload;
};
```

### Text control messages (JSON)

```ts
// Send slider update
channel.push('slider_update', { track_id: '123', volume: 0.8 });

// Receive state broadcast
channel.on('state_update', (payload) => {
  useProjectStore.getState().applyStateUpdate(payload);
});
```

---

## 7. REST API Client (api/rest.ts)

All REST calls are typed `fetch` wrappers. Base URL is `/api`.

### ETag-aware project update

```ts
async function updateProject(id: string, data: Partial<Project>, etag: string): Promise<Project> {
  const res = await fetch(`/api/projects/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': etag,
    },
    body: JSON.stringify(data),
  });
  if (res.status === 412) throw new Error('Conflict: project was modified by another user.');
  if (res.status === 428) throw new Error('ETag required for update.');
  if (!res.ok) throw new Error(`Update failed: ${res.status}`);
  return res.json();
}
```

### Idempotent export start

```ts
async function startExport(projectId: string, token: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/exports?token=${token}`, {
    method: 'POST',
  });
  if (res.status === 202) return; // accepted or already running
  if (res.status === 303) { /* redirect to completed export */ return; }
  throw new Error(`Export failed: ${res.status}`);
}
```

### Paginated samples

```ts
async function fetchSamples(page: number, limit = 50): Promise<Sample[]> {
  const res = await fetch(`/api/samples?page=${page}&limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch samples');
  return res.json();
}
```

### Sample upload (multipart)

```ts
async function uploadSample(file: File, name: string, genre: string): Promise<Sample> {
  const form = new FormData();
  form.append('file', file);
  form.append('name', name);
  form.append('genre', genre);
  const res = await fetch('/api/samples', { method: 'POST', body: form });
  if (!res.ok) throw new Error('Upload failed');
  return res.json();
}
```

---

## 8. Styling Rules

- **Zero CSS-in-JS.** No `styled-components`, no `emotion`, no inline `style` objects for layout.
- **Tailwind classes only** for all visual styling.
- Direct DOM mutations via `useRef` (for real-time animation) may set `style.property` — this is the only allowed exception.
- Icons: use `lucide-react` exclusively. Example: `import { Play, Square } from 'lucide-react'`.
- No Heroicons, no Material Icons, no SVG sprites from external sources.

---

## 9. TypeScript Rules

- TypeScript is **mandatory** — no `.js` files in `src/`.
- **Always** type binary data correctly:
  - PCM data: `Float32Array`
  - FFT data: `Uint8Array`
  - Raw frames: `ArrayBuffer`
  - Never mix these up — incorrect typed array views cause silent audio corruption.
- Use `strict: true` (already configured in `tsconfig.app.json`).
- Prefer `interface` for object shapes, `type` for unions and aliases.
- Never use `any` — use `unknown` and narrow with type guards.

---

## 10. Binary Frame Decoding Reference

Received from Phoenix Channel as `ArrayBuffer`:

```ts
function decodeAudioFrame(buffer: ArrayBuffer): { fft: Uint8Array; pcm: Float32Array } {
  const msgType = new DataView(buffer).getUint8(0); // should be 1
  const fft = new Uint8Array(buffer, 4, 512);        // bytes 4–515
  const pcm = new Float32Array(buffer, 516);          // bytes 516+ (N samples)
  return { fft, pcm };
}
```

**Byte layout:**

| Offset | Size    | Type          | Content                    |
|--------|---------|---------------|----------------------------|
| 0      | 1 byte  | `Uint8`       | Message type (`1` = audio) |
| 1–3    | 3 bytes | padding       | Zero bytes (alignment)     |
| 4–515  | 512 B   | `Uint8Array`  | FFT bins (0–255)           |
| 516+   | N×4 B   | `Float32Array`| PCM samples (−1.0 to 1.0) |

---

## 11. Build & Dev Commands

```bash
npm install         # install dependencies
npm run dev         # Vite HMR dev server (proxies /api and /socket to :4000)
npm run build       # tsc -b && vite build (type-check + bundle)
npm run lint        # ESLint
npm run preview     # serve production build locally
```

**Vite proxy** should be configured in `vite.config.ts` to route API and WebSocket traffic:

```ts
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
      '/socket': { target: 'ws://localhost:4000', ws: true },
    },
  },
});
```

---

## 12. Token Generation for Idempotent Exports

Generate UUIDs client-side with the built-in Web Crypto API — no library needed:

```ts
const token = crypto.randomUUID(); // returns string like "550e8400-e29b-41d4-a716-446655440000"
```

Store the token in Zustand alongside the export status so retries reuse the same token.

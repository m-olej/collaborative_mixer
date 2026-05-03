# Cloud DAW — Frontend Agent Guide

> React + TypeScript SPA. Read root `AGENTS.md` first for cross-cutting concerns.
> Run `npm run lint && npm run build` to validate work before finishing.

---

## 1. Technology Stack

| Technology       | Version   | Role                                                      |
|------------------|-----------|-----------------------------------------------------------|
| React            | ^19       | UI component tree; slow/structural state only             |
| TypeScript       | ~5+       | Mandatory for all `src/` files                            |
| Vite             | ^6+       | Dev server + production bundler                           |
| Tailwind CSS     | ^4        | All styling via `@tailwindcss/vite` plugin                |
| Zustand          | ^5        | Global state outside React lifecycle                      |
| React Router DOM | ^7        | Client-side routing                                       |
| phoenix (JS)     | ^1.8      | Phoenix Channel WebSocket client                          |
| lucide-react     | latest    | Icon set                                                  |

---

## 2. Source Structure

```
frontend/src/
├── main.tsx                 ← React root, Router provider
├── App.tsx                  ← Top-level route layout
├── App.css / index.css      ← Base global styles (prefer Tailwind)
├── api/
│   └── rest.ts              ← Typed fetch wrappers for all REST endpoints
├── types/
│   └── daw.ts               ← ALL shared TypeScript types + decode helpers
├── store/
│   ├── useSocketStore.ts    ← Zustand: Phoenix socket/channel + all WS event handlers
│   ├── useProjectStore.ts   ← Zustand: project list, create, fetch
│   ├── useDesignViewStore.ts ← Zustand: multi-user synth params, per-view state, audio sync
│   ├── useTimelineStore.ts  ← Zustand: track list, ETag map, drag/drop ops
│   └── useCollabStore.ts    ← Zustand: local user identity, remote cursors/selections
├── hooks/
│   ├── useAudioWorklet.ts   ← AudioContext + AudioWorklet lifecycle
│   └── useMetronome.ts      ← Click-track metronome timing
├── presets/
│   └── synthPresets.ts      ← ~15 factory presets (Basses, Synths, Pads, Drums)
├── components/
│   ├── AudioVisualization.tsx     ← FFT spectrum + oscilloscope (forwardRef, rAF)
│   ├── SpectrumCanvas.tsx         ← Standalone FFT-only canvas (rAF)
│   ├── Keyboard.tsx               ← Piano keyboard with note_preview events, octave switching
│   ├── AdsrEnvelope.tsx           ← Canvas ADSR visualization + time/level sliders
│   ├── MixerView.tsx              ← Mixer tab container
│   ├── ProjectList.tsx            ← Project selection screen
│   ├── ProjectWorkspace.tsx       ← Top-level workspace; owns WebSocket connection
│   ├── SynthControls.tsx          ← Synth parameter panel (29 params, presets, ADSR, keyboard)
│   ├── Collaboration/
│   │   └── CursorOverlay.tsx      ← SVG layer for remote user cursors
│   ├── Design/
│   │   ├── DesignView.tsx         ← Design tab container
│   │   ├── PianoRoll.tsx          ← Note editor; emits render_bar events
│   │   └── SampleRecorder.tsx     ← save_sample flow
│   └── Mixer/
│       ├── MasterBus.tsx          ← Master volume fader
│       ├── SampleBrowser.tsx      ← REST: paginated /api/samples
│       ├── Timeline.tsx           ← Timeline ruler + lane container
│       ├── TimelineClip.tsx       ← Individual clip with waveform peaks
│       ├── TimelineLane.tsx       ← Drag target lane
│       └── TrackStrip.tsx         ← Per-track volume/mute/pan controls
└── public/
    └── audio-processor.js         ← AudioWorkletProcessor (served as static file)
```

---

## 3. CRITICAL: Real-Time Rendering Rule

**Never use `useState` or Zustand for data arriving at audio/video frame rate.**
Use `useRef` + direct DOM / canvas mutation instead.

```tsx
// ✅ CORRECT — forwardRef + useImperativeHandle pattern (AudioVisualization.tsx)
export const AudioVisualization = forwardRef<AudioVisualizationHandle>(
  function AudioVisualization(_props, ref) {
    const fftDataRef = useRef<Uint8Array>(new Uint8Array(512));
    useImperativeHandle(ref, () => ({
      updateVisualization(fft: Uint8Array, pcm: Float32Array) {
        fftDataRef.current = fft;   // direct write, no React update
      },
    }));
    // draw loop driven by requestAnimationFrame, not by React
  }
);

// ❌ WRONG — triggers reconciliation on every audio frame
const [fftData, setFftData] = useState(new Uint8Array(512));
channel.on("audio_buffer", (buf) => setFftData(new Uint8Array(buf, 4, 512)));
```

### What to use `useRef` + rAF for (all real-time)
- FFT / oscilloscope canvas drawing (`AudioVisualization`, `SpectrumCanvas`)
- Volume meter / VU meter bar heights
- Playhead position animation

### What to use Zustand / `useState` for (slow state)
- Project metadata, BPM, track list
- UI modal open/close
- Sample library pagination
- WebSocket connection status

---

## 4. Zustand Stores

### `useDesignViewStore` — multi-user synth state
- Per-user isolation: each user has `viewId = "design:{username}"`.
- `designViews: Record<string, { synth_params: SynthParams }>` — tracks all users' views.
- `initFromServer(views)` — merges with `DEFAULT_SYNTH_PARAMS`.
- `patchView(viewId, params)` — optimistic local update.
- `handleRemoteUpdate(viewId, params)` — apply peer's changes.
- `getActiveParams()` — returns current view's SynthParams.
- `syncByView: Record<string, boolean>` — per-view audio sync toggles.

### `useSocketStore` — primary real-time hub
- Owns the `Phoenix.Socket` and `Channel` instances.
- `connect(projectId)` joins `"project:{id}"`, sets `mixerState` on OK.
- Registers **all** WebSocket event handlers in one place:
  - `audio_buffer`, `bar_audio`, `audio_frame`, `note_audio`, `voice_audio` → calls `onVisualizationData` callback
  - `slider_update` → merges into `mixerState`
  - `track_placed`, `track_moved`, `track_removed` → delegates to `useTimelineStore`
  - `presence_state`, `presence_diff` → delegates to `useCollabStore`
  - `cursor_move`, `selection_update` → delegates to `useCollabStore`
- `setVisualizationCallback(cb)` — called by `ProjectWorkspace` to wire up `AudioVisualization`.
- `pushCursorMove(x, y)` / `pushSelectionUpdate(sel)` — outgoing collaboration events.

### `useTimelineStore`
- Holds `tracks: Track[]` and `etags: Record<number, string>`.
- `moveTrack` sends `PUT /api/projects/:id/tracks/:tid` with `If-Match` header; on 412 re-fetches.
- `handleTrackPlaced/Moved/Removed` — called by `useSocketStore` for real-time sync.
- Exposes `zoom` (px/ms) and `snapEnabled/snapResolution` for the timeline ruler.

### `useCollabStore`
- `localUser` — loaded from `localStorage` (`daw_username`, `daw_user_color`).
- `remoteUsers` — map of `username → { color, cursor, selection }`.
- Updated via Presence diff events from the socket.

### `useProjectStore`
- Thin wrapper around `api.listProjects()` / `api.createProject()`.

---

## 5. WebSocket Event Reference

### Outgoing (client → server)

| Event             | Payload                                           | Handler         |
|-------------------|---------------------------------------------------|-----------------|
| `patch_update`    | SynthParams map (string keys) + `view_id`         | SynthControls   |
| `sync_params`     | SynthParams map (string keys) + `view_id`         | SynthControls (debounced 150ms, no render) |
| `slider_update`   | `{track_id?, volume?, pan?, muted?, master_volume?}` | TrackStrip / MasterBus |
| `render_bar`      | `{notes: RecordedNote[], bar_duration_ms, view_id}` | PianoRoll       |
| `note_preview`    | `{frequency, midi, view_id}`                      | Keyboard        |
| `key_up`          | `{midi}`                                          | Keyboard (triggers ADSR release on server) |
| `save_sample`     | `{name, genre?, input_history?, bar_duration_ms, bar_count}` | SampleRecorder |
| `cursor_move`     | `{x, y}`                                         | ProjectWorkspace (throttled 50 ms) |
| `selection_update`| `CollabSelection \| {}`                          | useSocketStore  |
| `ping`            | any                                               | health check    |

### Incoming (server → client)

| Event             | Payload                     | Consumer                       |
|-------------------|-----------------------------|--------------------------------|
| `audio_buffer`    | `ArrayBuffer` (binary, type 2) | useSocketStore → AudioVisualization |
| `bar_audio`       | `ArrayBuffer` (binary, type 2) | useSocketStore → AudioVisualization |
| `audio_frame`     | `ArrayBuffer` (binary, type 1) | useSocketStore → AudioVisualization |
| `note_audio`      | `ArrayBuffer` (binary)      | useSocketStore → AudioVisualization (legacy) |
| `voice_audio`     | `ArrayBuffer` (binary, MIDI in byte 1) | SynthControls → mixPcm() (polyphonic streaming) |
| `voice_done`      | `{midi: number}`            | SynthControls (cleanup)        |
| `design_view_update` | `{view_id, synth_params}` | useDesignViewStore             |
| `slider_update`   | mixer params JSON           | useSocketStore → mixerState    |
| `track_placed`    | `{track: Track}`            | useTimelineStore               |
| `track_moved`     | `{track: Track}`            | useTimelineStore               |
| `track_removed`   | `{track_id: number}`        | useTimelineStore               |
| `presence_state`  | Presence map                | useCollabStore                 |
| `presence_diff`   | `{joins, leaves}`           | useCollabStore                 |
| `cursor_move`     | `{user, color, x, y}`       | useCollabStore                 |
| `selection_update`| `{user, color, selection}`  | useCollabStore                 |

---

## 6. Binary Audio Frame Decoding

All audio events (`audio_buffer`, `bar_audio`, `audio_frame`, `note_audio`) carry the same binary frame layout:

```ts
// From src/types/daw.ts
export function decodeAudioFrame(buffer: ArrayBuffer): AudioFrame {
  const fft = new Uint8Array(buffer, 4, 512);   // bytes 4–515
  const pcm = new Float32Array(buffer, 516);    // bytes 516+
  return { fft, pcm };
}
```

This is already decoded inside `useSocketStore` before feeding the visualization. **Do not use `decodeAudioFrame` again in components** — receive `fft` and `pcm` directly via the `onVisualizationData` callback.

---

## 7. REST API Layer (`src/api/rest.ts`)

All REST calls go through the typed `api` object. Key contracts:

| Function                              | Method | Endpoint                                    | Notes                         |
|---------------------------------------|--------|---------------------------------------------|-------------------------------|
| `api.listProjects()`                  | GET    | `/api/projects`                             |                               |
| `api.getProject(id)`                  | GET    | `/api/projects/:id`                         | Returns `{project, etag}`     |
| `api.createProject(name, bpm)`        | POST   | `/api/projects`                             |                               |
| `api.updateProject(id, data, etag)`   | PUT    | `/api/projects/:id`                         | Requires ETag; throws on 412/428 |
| `api.deleteProject(id)`               | DELETE | `/api/projects/:id`                         |                               |
| `api.listSamples(page, limit)`        | GET    | `/api/samples?page=&limit=`                 | Returns `PaginatedResponse`   |
| `api.deleteSample(id)`                | DELETE | `/api/samples/:id`                          |                               |
| `api.startExport(projectId, token)`   | POST   | `/api/projects/:id/exports?token=`          | Returns 202 or 303            |
| `api.listTracks(projectId)`           | GET    | `/api/projects/:id/tracks`                  |                               |
| `api.createTrack(projectId, data)`    | POST   | `/api/projects/:id/tracks`                  | Returns `{track, etag}`       |
| `api.updateTrack(pId, tId, data, etag)` | PUT  | `/api/projects/:id/tracks/:tid`             | Requires ETag; throws on 412/428 |
| `api.deleteTrack(projectId, trackId)` | DELETE | `/api/projects/:id/tracks/:tid`             |                               |

The `request<T>()` helper throws on non-2xx, returns `undefined` on 204/202 with no body.

---

## 8. Key Types (`src/types/daw.ts`)

```ts
// REST resources
Project, Track, Sample, Export, PaginatedResponse<T>

// WebSocket mixer state (received on channel join)
MixerState { project_id, tracks: Record<string, TrackMixerState>, master_volume, playing, playhead_ms }
TrackMixerState { volume, muted, solo, pan, eq: EqSettings }

// Synth parameters (29 fields — matches Rust SynthState exactly)
SynthParams {
  osc_shape, frequency,
  unison_voices, unison_detune, unison_spread,
  cutoff, resonance, filter_type,
  drive, distortion_type, distortion_amount,
  lfo_rate, lfo_depth, lfo_shape, lfo_target,
  chorus_rate, chorus_depth, chorus_mix,
  reverb_decay, reverb_mix,
  volume,
  amp_attack_ms, amp_decay_ms, amp_sustain, amp_release_ms,
  filter_attack_ms, filter_decay_ms, filter_sustain, filter_release_ms, filter_env_depth
}
DEFAULT_SYNTH_PARAMS — mirrors Rust SynthState::default()

// Collaboration
CollabUser { username, color }
RemoteUser { username, color, cursor: {x,y} | null, selection: CollabSelection | null }
CollabSelection { trackId, startMs, endMs }

// Timeline
SnapResolution = "bar" | "beat" | "sixteenth"
WaveformPeak { min, max }   // used by TimelineClip for thumbnail
RecordedNote { midi, note, frequency, start_ms, end_ms }
```

---

## 9. Audio Worklet

All audio playback runs in an `AudioWorkletProcessor` (`public/audio-processor.js`, served as static file).

```ts
// useAudioWorklet.ts bootstrap pattern
const ctx = new AudioContext({ sampleRate: 44100 });
await ctx.audioWorklet.addModule('/audio-processor.js');
const node = new AudioWorkletNode(ctx, 'cloud-daw-processor');
node.connect(ctx.destination);
```

Rules:
- `audio-processor.js` has no imports from `node_modules` — it runs in `AudioWorkletGlobalScope`.
- Feed PCM to the worklet via `node.port.postMessage(pcm)` only — no shared state with React.
- Two playback modes: `feedPcm()` for sequential playback, `mixPcm()` for additive polyphonic mixing (used by voice streaming).
- The `useAudioWorklet` hook manages `AudioContext` lifecycle (create on first user gesture, suspend/resume on tab visibility).

---

## 10. Collaboration Features

- **Presence**: tracked via Phoenix Presence. On join, `presence_state` provides the full map; `presence_diff` delivers incremental updates. User identity (`username`, `color`) is set in `useCollabStore` and persisted to `localStorage`.
- **Cursors**: `ProjectWorkspace` throttles `mousemove` to 50 ms intervals before pushing `cursor_move`. `CursorOverlay` renders SVG cursor dots for each `remoteUser`.
- **Selections**: `useCollabStore.localSelection` is pushed via `pushSelectionUpdate`; remote selections are rendered per component.

---

## 11. Validation

```bash
cd frontend
npm run lint      # ESLint
npm run build     # TypeScript type check + Vite production build
```

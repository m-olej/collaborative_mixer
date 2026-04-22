# Frontend

The frontend is a React + TypeScript single-page application built with Vite, using Tailwind CSS for styling and Zustand for state management.

**Location**: `frontend/`

## Technology Stack

| Technology | Version | Purpose |
|---|---|---|
| React | 19.x | UI component framework |
| TypeScript | 6.x | Type-safe JavaScript |
| Vite | 8.x | Build tool and dev server |
| Tailwind CSS | 4.x | Utility-first CSS framework |
| Zustand | 5.x | Lightweight state management |
| Phoenix (JS) | 1.8.x | WebSocket client for Phoenix Channels |
| Lucide React | 1.8.x | Icon library |

## Development Setup

```bash
npm install
npm run dev    # Vite dev server on :5173, proxies /api and /socket to :4000
npm run build  # TypeScript check + production build
npm run lint   # ESLint
```

**Proxy configuration** (vite.config.ts):
- `/api` → `http://localhost:4000`
- `/socket` → `ws://localhost:4000`

---

## Component Tree

```
App
├── ProjectList                          # Dashboard: list/create projects
└── ProjectWorkspace                     # Active project container
    ├── ProjectSettings                  # BPM, time signature, count-in editing
    ├── MixerView (tab)
    │   ├── SpectrumCanvas               # FFT visualizer (512 bars, canvas)
    │   ├── TrackStrip[]                 # Per-track: volume, mute, 3-band EQ
    │   ├── MasterBus                    # Master volume, transport, BPM display
    │   └── SampleBrowser                # Paginated sample library sidebar
    └── DesignView (tab)
        ├── SynthControls                # Full synthesizer parameter UI
        │   ├── Spectrum + Oscilloscope  # Dual canvas visualizers
        │   ├── Parameter sections       # Osc, unison, filter, LFO, FX, amp
        │   └── Keyboard                 # 2-octave QWERTY piano (C3–B4)
        ├── SampleRecorder               # Recording state machine
        └── PianoRoll                    # Canvas note visualization
```

---

## State Management

### `useProjectStore` (Zustand)

Manages the project list for the dashboard.

| State | Type | Description |
|---|---|---|
| `projects` | `Project[]` | All projects |
| `loading` | `boolean` | Fetch in progress |
| `error` | `string \| null` | Error message |

| Action | Description |
|---|---|
| `fetchProjects()` | Calls `api.listProjects()` and updates state |
| `createProject(name, bpm)` | Creates project and appends to list |

### `useSocketStore` (Zustand)

Manages the WebSocket connection and real-time mixer state.

| State | Type | Description |
|---|---|---|
| `socket` | `Socket \| null` | Phoenix Socket instance |
| `channel` | `Channel \| null` | Active project channel |
| `connected` | `boolean` | Connection status |
| `mixerState` | `MixerState` | Tracks, master volume, transport |

| Action | Description |
|---|---|
| `connect(projectId)` | Creates socket, joins `project:{id}`, initializes mixer state from server snapshot |
| `disconnect()` | Leaves channel, disconnects socket, resets state |

On join, the store listens for `slider_update` broadcasts from other clients and applies them to `mixerState`.

---

## Audio Pipeline

### AudioWorklet (`useAudioWorklet` hook + `audio-processor.js`)

The audio playback system consists of two parts:

**Main thread** (`useAudioWorklet.ts`):
- Creates `AudioContext` at 44,100 Hz
- Loads `CloudDawProcessor` worklet from `/audio-processor.js`
- Exposes `feedPcm(pcm)` — appends PCM to ring buffer (sequential playback)
- Exposes `mixPcm(pcm)` — additively mixes PCM at current read position (polyphonic overlay)
- Exposes `getContext()` — returns `AudioContext` for creating `AudioBufferSourceNode` instances

**Audio thread** (`audio-processor.js`):
- `CloudDawProcessor` extends `AudioWorkletProcessor`
- Pre-allocated ring buffer: 441,000 samples (10 seconds at 44.1 kHz)
- Two write modes:
  - **Append** (`Float32Array` message): writes to `writePos`, advances cursor
  - **Mix** (`{type: "mix", pcm}` message): adds to existing buffer at `readPos`
- `process()`: reads 128 samples per quantum (~344 calls/sec), zero-allocation
- Handles underrun (outputs silence) and overflow (drops oldest samples)

### Note Preview (`AudioBufferSourceNode`)

Keyboard note previews bypass the ring buffer entirely:

1. User presses key → `note_preview` event sent to server (frequency + MIDI)
2. Server renders 3 seconds of audio, returns binary frame with MIDI in byte 1
3. Client creates `AudioBuffer` from PCM, plays via `AudioBufferSourceNode`
4. Each note gets its own `GainNode` for independent fade-out
5. On key release: `gain.setTargetAtTime(0, now, 0.015)` → ~45 ms fade → `source.stop()`
6. Active notes tracked in `Map<midi, {source, gain}>` for re-trigger and release

### Metronome (`useMetronome` hook)

Count-in metronome generates clicks entirely in JavaScript (the only client-side audio generation):

- Click sound: 1 kHz sine burst, 15 ms, exponential decay (`e^(-300t)`)
- Pre-generated once as a `Float32Array` constant
- `generateCountIn(opts)`: places clicks at even intervals across one bar
- `playCountIn(feedPcm, opts)`: feeds entire count-in to AudioWorklet, returns Promise

---

## Key Components

### `ProjectList`

Dashboard view: lists all projects, allows creating new ones with name and BPM.

### `ProjectWorkspace`

Top-level container for an active project:
- Establishes shared WebSocket connection on mount
- Manages local project state (mutable copy for settings editing)
- Fetches ETag on mount for optimistic locking
- Tab bar: Mixer / Design
- Settings panel: BPM, time signature, count-in note value (saves via REST with ETag)

### `SynthControls`

Full synthesizer parameter UI with server-side rendering:

**Sections**: Oscillator, Unison, Filter, LFO, Drive/Distortion, Chorus, Reverb, Volume

**Rendering**:
- Slider/select changes → debounced `patch_update` (150 ms)
- "Render Sound" button → immediate `patch_update`
- Keyboard notes → `note_preview` (no debounce)

**Visualization**: Dual canvas displays updated via `requestAnimationFrame`:
- **Spectrum**: 512 frequency bars, HSL-colored by frequency
- **Oscilloscope**: 1024-sample waveform with center line

**Event handling**:
- `audio_buffer` → updates visualizations + feeds PCM to ring buffer
- `note_audio` → creates AudioBufferSourceNode for the specific MIDI note

### `Keyboard`

Two-octave QWERTY piano keyboard (C3–B4, MIDI 48–71):

**Key mapping**:
```
Lower octave (C3–B3): Z S X D C V G B H N J M
Upper octave (C4–B4): Q 2 W 3 E R 5 T 6 Y 7 U
```

**Features**:
- Keyboard and mouse input
- Visual key highlighting for active notes
- Global `keydown`/`keyup` listeners (skips `INPUT`/`TEXTAREA`/`SELECT` elements)
- `NoteEvent` export: `{midi, note, frequency}`

### `SampleRecorder`

Recording workflow state machine:

```
idle → count-in → recording → rendering → done
  ▲                                         │
  └─────────────────────────────────────────┘
                  (re-record)
```

**Exposed via `forwardRef` + `useImperativeHandle`**: parent forwards keyboard `noteOn`/`noteOff` events.

**Recording process**:
1. Click "Record" → wipes previous sample, enters count-in
2. Metronome plays one bar of count-in clicks
3. Recording phase starts — keyboard events captured with `performance.now()` timestamps
4. Auto-stop after `barDurationMs × barCount` milliseconds
5. Open notes are closed at the recording boundary
6. `render_bar` event sent to server with note events + total duration
7. Server renders polyphonically, returns `bar_audio` binary
8. `LocalSample` created with PCM, FFT, input history, bar count

**Configurable**: bar count (1, 2, 3, 4, 6, 8) and count-in grid (quarter/eighth/sixteenth).

### `PianoRoll`

Canvas-based MIDI note visualization (600 × 384 px):

**Layout**:
- Y axis: 24 pitch rows (C3–B4, MIDI 48–71), highest pitch at top
- X axis: time (0 to total duration)
- Left margin: 36 px for note name labels

**Visual elements**:
- Row backgrounds: white keys vs. black keys (darker)
- Subdivision grid lines (count-in note value resolution)
- Beat lines (quarter note resolution, thicker)
- Bar boundary lines (indigo, thick — for multi-bar recordings)
- Note rectangles: colored by pitch (HSL hue based on MIDI), with borders

**Playback**: button feeds `localSample.pcm` to AudioWorklet.

### `SpectrumCanvas`

FFT spectrum visualizer used in the mixer view:
- 512 frequency bars, HSL-colored
- Updated via DOM property `_updateFft` (avoids React re-render)
- `requestAnimationFrame` draw loop

### `TrackStrip`

Vertical mixer channel strip:
- Volume fader (0–1)
- Mute toggle
- 3-band EQ: low, mid, high (±12 dB)
- Debounced `slider_update` events (150 ms)

### `MasterBus`

Master mixer controls:
- Master volume fader
- Play/Stop transport toggle
- BPM display

### `SampleBrowser`

Paginated sample library browser:
- Fetches from `GET /api/samples?page=N&limit=20`
- Displays: name, genre, duration
- Auto-loads page 1 on mount

---

## Type System

All shared types are defined in `types/daw.ts`:

**REST entities**: `Project`, `Track`, `Sample`, `Export`, `PaginatedResponse<T>`

**Mixer**: `TrackMixerState`, `EqSettings`, `MixerState`

**Audio**: `AudioFrame`, `SynthParams` (mirrors Rust `SynthState`)

**Recording**: `RecordedNote`, `RecordingPhase`, `LocalSample`, `CountInNoteValue`

**Helpers**: `decodeAudioFrame()`, `parseTimeSignature()`, `barDurationMs()`, `clicksPerBar()`

---

## File Inventory

| File | Purpose |
|---|---|
| `src/App.tsx` | Root component, project selection |
| `src/main.tsx` | ReactDOM entry point |
| `src/types/daw.ts` | All TypeScript type definitions |
| `src/api/rest.ts` | REST API client functions |
| `src/store/useProjectStore.ts` | Project list state |
| `src/store/useSocketStore.ts` | WebSocket connection state |
| `src/hooks/useAudioWorklet.ts` | AudioWorklet lifecycle |
| `src/hooks/useMetronome.ts` | Count-in click generator |
| `src/components/ProjectList.tsx` | Project dashboard |
| `src/components/ProjectWorkspace.tsx` | Project container + settings |
| `src/components/MixerView.tsx` | Mixer tab layout |
| `src/components/SpectrumCanvas.tsx` | FFT canvas visualizer |
| `src/components/SynthControls.tsx` | Synthesizer UI + keyboard |
| `src/components/Keyboard.tsx` | QWERTY piano keyboard |
| `src/components/Mixer/TrackStrip.tsx` | Channel strip |
| `src/components/Mixer/MasterBus.tsx` | Master bus controls |
| `src/components/Mixer/SampleBrowser.tsx` | Sample library browser |
| `src/components/Design/DesignView.tsx` | Design tab layout |
| `src/components/Design/SampleRecorder.tsx` | Recording state machine |
| `src/components/Design/PianoRoll.tsx` | Note visualization canvas |
| `public/audio-processor.js` | AudioWorklet ring buffer processor |

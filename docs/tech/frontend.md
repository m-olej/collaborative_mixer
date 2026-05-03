# Frontend

## Stack

| Technology | Version | Purpose |
|---|---|---|
| React | 19 | Component library |
| TypeScript | 5+ | Type-safe JS |
| Vite | 6+ | Dev server + bundler |
| Tailwind CSS | v4 | Utility-first styling |
| Zustand | 5 | State management |
| phoenix (JS) | 1.8 | WebSocket client (Phoenix Channels) |
| lucide-react | — | Icon library |

## Source Structure

```
frontend/src/
├── main.tsx                         # ReactDOM entry point
├── App.tsx                          # Root router: ProjectList ↔ ProjectWorkspace
├── App.css / index.css              # Global styles
│
├── api/
│   └── rest.ts                      # REST client: all CRUD endpoints + optimistic locking
│
├── types/
│   └── daw.ts                       # All TypeScript types: Project, Track, Sample, SynthParams, MixerState
│
├── store/
│   ├── useProjectStore.ts           # Projects CRUD state (REST-backed)
│   ├── useSocketStore.ts            # Phoenix WebSocket lifecycle, mixer state, binary frame handlers
│   ├── useDesignViewStore.ts        # Multi-user synth params: per-view state, audio sync
│   ├── useTimelineStore.ts          # Timeline: tracks, playhead, zoom, snap, selections, drag state
│   └── useCollabStore.ts            # Local/remote users, cursor positions, keyboard collab
│
├── hooks/
│   ├── useAudioWorklet.ts           # Web Audio API: AudioContext + AudioWorkletNode lifecycle
│   └── useMetronome.ts              # Count-in generator (sine clicks + timing)
│
├── presets/
│   └── synthPresets.ts              # ~15 factory presets (Basses, Synths/Keys, Pads, Drums)
│
├── components/
│   ├── ProjectList.tsx              # Dashboard: list, create, edit, delete projects; user identity
│   ├── ProjectWorkspace.tsx         # WebSocket lifecycle, tab switching (Mixer/Design), settings
│   ├── AudioVisualization.tsx       # Dual canvas: FFT spectrum + oscilloscope
│   ├── SpectrumCanvas.tsx           # Standalone FFT component (available, unused in layout)
│   ├── SynthControls.tsx            # Full synth panel: 29 params, presets, keyboard, ADSR
│   ├── Keyboard.tsx                 # 2-octave piano: QWERTY + mouse, octave switching, collab
│   ├── AdsrEnvelope.tsx             # Canvas ADSR visualization + time/level sliders
│   │
│   ├── Design/
│   │   ├── DesignView.tsx           # Sample design: multi-user tabs, synth + recorder + piano roll
│   │   ├── SampleRecorder.tsx       # Recording state machine: count-in → record → render → save
│   │   └── PianoRoll.tsx            # Canvas: MIDI grid (C3–B4, 24 rows), note display
│   │
│   ├── Mixer/
│   │   ├── TrackStrip.tsx           # Vertical fader: volume, mute, solo, pan, 3-band EQ
│   │   ├── MasterBus.tsx            # Master volume + transport controls + BPM
│   │   ├── Timeline.tsx             # Beat grid + lane layout, drag-drop, playhead, seek
│   │   ├── TimelineLane.tsx         # Single lane: grid lines + clip children
│   │   ├── TimelineClip.tsx         # Draggable clip: waveform peaks canvas, multi-select
│   │   └── SampleBrowser.tsx        # Paginated sample library (GET /api/samples?page=N)
│   │
│   └── Collaboration/
│       └── CursorOverlay.tsx        # Colored cursor dots + usernames for remote users
│
└── public/
    └── audio-processor.js           # AudioWorklet processor (ring buffer playback)
```

## Component Tree

```
App
├── ProjectList                        (no project selected)
│   ├── User identity card
│   ├── New project form
│   └── ProjectRow[] (inline edit + delete)
│
└── ProjectWorkspace                   (project selected)
    ├── CursorOverlay
    ├── Tab bar (Mixer / Design, sync toggle, connection status)
    ├── ProjectSettings (conditional panel)
    ├── AudioVisualization
    │
    ├── MixerView                      (Mixer tab)
    │   ├── Timeline
    │   │   └── TimelineLane[]
    │   │       └── TimelineClip[]
    │   ├── TrackStrip[] + MasterBus
    │   └── SampleBrowser
    │
    └── DesignView                     (Design tab)
        ├── Multi-user view tabs
        ├── SynthControls
        │   ├── PresetSelector
        │   ├── Oscillator + Unison
        │   ├── Filter + LFO
        │   ├── Drive + Chorus + Reverb
        │   ├── AdsrEnvelope (AMP / FILTER tabs)
        │   ├── Volume + Render button
        │   └── Keyboard
        └── SampleRecorder
            ├── Record / Stop / Play buttons
            ├── PianoRoll (canvas)
            └── Save to library form
```

## Audio Pipeline

### AudioWorklet Architecture

Audio playback uses the Web Audio API's AudioWorklet for glitch-free, off-main-thread PCM playback.

**Setup** (`useAudioWorklet.ts`):
1. Create `AudioContext` at 44,100 Hz sample rate
2. Load `/audio-processor.js` worklet module
3. Create `AudioWorkletNode("cloud-daw-processor")` → connect to `destination`

**Two playback modes:**

| Method | Message Type | Behavior | Used By |
|---|---|---|---|
| `feedPcm(pcm)` | `{ type: "feed", pcm }` | Sequential playback — queues after current buffer | Timeline, render previews |
| `mixPcm(pcm)` | `{ type: "mix", pcm }` | Additive mixing — sums into ring buffer at playback position | Voice streaming (keyboard) |

### Streaming Voice Preview

When a key is pressed on the keyboard, the frontend sends a `note_preview` message to the server. The server spawns a `VoiceStreamer` process that streams audio chunks back as `voice_audio` binary events.

```
Key press → note_preview (JSON) → Server spawns VoiceStreamer
                                    ↓
              voice_audio (binary, 200ms burst) → extract PCM → mixPcm()
              voice_audio (binary, 50ms pace)   → extract PCM → mixPcm()
              voice_audio (binary, 50ms pace)   → extract PCM → mixPcm()
              ...
Key release → key_up (JSON) → Server triggers ADSR release
              voice_audio continues during release tail...
              voice_done (JSON) → cleanup
```

**Implementation** (`SynthControls.tsx`):
- `voice_audio` handler: extracts FFT (offset 4, 512 bytes) and PCM (offset 516), calls `mixPcm()` for additive polyphonic playback
- `handleNoteOff`: sends `key_up` to channel — no client-side fade-out, server handles release envelope
- Multiple keys can be held simultaneously — each gets its own `VoiceStreamer` on the server

### Timeline Playback

Timeline audio uses the burst & pace protocol via `UserSession` GenServer:
1. `start_playback` → server renders 200 ms burst → `audio_frame` binary
2. Server ticks every 50 ms → `audio_frame` binary chunks
3. Client receives frames → `feedPcm()` for sequential playback
4. `stop_playback` → server cancels timer

## State Management (Zustand)

### useProjectStore
REST-backed project CRUD. Actions: `fetchProjects`, `createProject`, `updateProject` (with ETag), `deleteProject`.

### useSocketStore
Phoenix WebSocket lifecycle. Holds `socket`, `channel`, `connected`, `mixerState`. Registers all binary frame handlers (`audio_buffer`, `bar_audio`, `voice_audio`, `audio_frame`) and JSON event handlers (`slider_update`, `track_placed`, `presence_state`, etc.).

### useDesignViewStore
Multi-user synth state management. Each user has a view ID (`"design:{username}"`). State shape:

```typescript
designViews: Record<string, { synth_params: SynthParams }>
activeViewId: string
syncByView: Record<string, boolean>
```

Key actions:
- `initFromServer(views)` — merges server state with `DEFAULT_SYNTH_PARAMS`
- `patchView(viewId, params)` — optimistic local update
- `handleRemoteUpdate(viewId, params)` — apply peer's changes
- `getActiveParams()` — returns current view's SynthParams

### useTimelineStore
Timeline state: `tracks`, `playheadMs`, `playing`, `zoom`, `snapEnabled`, `snapResolution`, `selectedTrackIds`, `draggingByUser`, `userCursors`. Supports `batchMoveSelectedTracks` for multi-select drag.

### useCollabStore
Collaboration: `localUser` (username + color), `remoteUsers`, `activeKeys` (Map of MIDI → remote players for keyboard collab visualization).

## Keyboard

`Keyboard.tsx` renders a 2-octave piano with QWERTY key mapping and octave switching (range 0–7, default 3).

**Key mapping:**
- Lower octave (baseOctave): `Z S X D C V G B H N J M`
- Upper octave (baseOctave+1): `Q 2 W 3 E R 5 T 6 Y 7 U`

`buildKeys(baseOctave)` generates `KeyDef[]` with MIDI numbers and frequencies (A4 = 440 Hz tuning). Octave switch buttons (−Oct / +Oct) let the user shift the entire keyboard.

Input sources: `keydown`/`keyup` events + mouse interactions. Collaboration: colored dots show remote users' held keys via `useCollabStore`.

## ADSR Envelope Component

`AdsrEnvelope.tsx` renders an interactive ADSR visualization:

- **Canvas** (320×100 + 16px label height): draws envelope shape with linear attack, exponential decay/release curves, grid background, phase labels (A/D/S/R)
- **4 sliders**: Attack (ms), Decay (ms), Sustain (level 0–1), Release (ms) — time sliders use quadratic mapping for finer control at low values
- **Accent colors**: Indigo for amp envelope, Yellow/Amber for filter envelope
- **Optional**: Filter envelope depth slider (shown only on filter tab)
- **Switchable**: AMP / FILTER tabs in the SynthControls panel

## Preset System

`synthPresets.ts` defines ~15 factory presets organized by category:

| Category | Presets |
|---|---|
| Basses | 808 Sub Bass, Dubstep Wub Bass |
| Synths/Keys | Supersaw Chord, Synth Pluck |
| Pads | Cinematic Pad |
| Drums | Closed Hi-Hat, Synth Snare |

Each preset is `Partial<SynthParams>` merged onto `DEFAULT_SYNTH_PARAMS`. `getPresetsByCategory()` returns a grouped Map for the preset selector dropdown. Selecting a preset calls `patchView()` + `sendParamSync()` to propagate to server and peers.

## Parameter Sync Strategy

Two separate WebSocket events handle synth parameter changes:

| Event | Trigger | Server Action | Debounce |
|---|---|---|---|
| `sync_params` | Slider/knob adjustment | Merge params, broadcast to peers | 150 ms |
| `patch_update` | "Render Sound" button | Merge params, render audio, return binary | None |

This prevents unnecessary audio renders during live knob tweaking while keeping all clients in sync.

## Canvas Rendering

### FFT Spectrum (`AudioVisualization.tsx`)
- Dual canvas: FFT bars (top) + oscilloscope waveform (bottom)
- `requestAnimationFrame` loop reads latest FFT/PCM data from visualization callback
- FFT: 512 bins mapped to canvas width, magnitude 0–255 → bar height
- Oscilloscope: Float32 PCM → line graph

### Piano Roll (`PianoRoll.tsx`)
- Canvas grid: 24 rows (C3–B4), time axis in milliseconds
- Recorded notes drawn as rectangles at grid positions
- Grid lines at beat/bar boundaries based on BPM

### Waveform Peaks (`TimelineClip.tsx`)
- Each clip renders min/max amplitude peaks on a canvas
- Peaks computed server-side via `generate_waveform_peaks` NIF

## REST API Client

`rest.ts` implements all REST endpoints with proper HTTP semantics:

- **Optimistic locking**: `updateProject()` sends `If-Match` header with ETag, handles `412 Precondition Failed`
- **Pagination**: `listSamples(page, limit)` for sample browser
- **Multipart upload**: sample file upload
- **Batch operations**: `batchMoveTracks()` for multi-select drag moves

## SynthParams Type

29 fields defined in `daw.ts`:

| Group | Fields |
|---|---|
| Oscillator | `osc_shape`, `frequency` |
| Unison | `unison_voices`, `unison_detune`, `unison_spread` |
| Filter | `cutoff`, `resonance`, `filter_type` |
| Drive | `drive`, `distortion_type`, `distortion_amount` |
| LFO | `lfo_rate`, `lfo_depth`, `lfo_shape`, `lfo_target` |
| Chorus | `chorus_rate`, `chorus_depth`, `chorus_mix` |
| Reverb | `reverb_decay`, `reverb_mix` |
| Amplitude | `volume` |
| Amp ADSR | `amp_attack_ms`, `amp_decay_ms`, `amp_sustain`, `amp_release_ms` |
| Filter ADSR | `filter_attack_ms`, `filter_decay_ms`, `filter_sustain`, `filter_release_ms`, `filter_env_depth` |

### Defaults

```typescript
const DEFAULT_SYNTH_PARAMS: SynthParams = {
  osc_shape: "saw", frequency: 440, unison_voices: 1, unison_detune: 15, unison_spread: 0.5,
  cutoff: 2500, resonance: 0.3, filter_type: "svf",
  drive: 1, distortion_type: "off", distortion_amount: 0,
  lfo_rate: 2, lfo_depth: 0, lfo_shape: "sine", lfo_target: "cutoff",
  chorus_rate: 1.5, chorus_depth: 0.3, chorus_mix: 0,
  reverb_decay: 0.5, reverb_mix: 0,
  volume: 0.7,
  amp_attack_ms: 10, amp_decay_ms: 100, amp_sustain: 0.8, amp_release_ms: 200,
  filter_attack_ms: 10, filter_decay_ms: 200, filter_sustain: 0.5, filter_release_ms: 300,
  filter_env_depth: 2000,
};
```

# WebSocket Protocol

## Connection

**Endpoint**: `ws://localhost:4000/socket/websocket`

The frontend connects using the Phoenix JavaScript client library. The Vite dev server proxies `/socket` to `ws://localhost:4000`.

**Transport**: WebSocket only (long-polling disabled).

## Channel: `project:{project_id}`

Each project has its own channel topic. Joining a channel ensures the corresponding `ProjectSession` GenServer is running and returns an initial state snapshot.

### Join

```
join "project:42"
```

**Payload** (optional):
```json
{ "username": "alice", "color": "#6366f1" }
```

**Reply** `{:ok, payload}` — includes full mixer state snapshot + design view state.

---

## Events: Client → Server

### `patch_update` — Synth Render

Updates synthesizer parameters and triggers a full audio render. The server merges the incoming parameters with the current design view state, calls the Rust DSP NIF, and returns the rendered audio as a binary frame.

**Payload** (JSON — all 29 synth fields optional, only changed values needed)

```json
{
  "osc_shape": "saw",
  "frequency": 440.0,
  "cutoff": 2500.0,
  "amp_attack_ms": 50,
  "filter_env_depth": 3000,
  "view_id": "design:alice"
}
```

**Server Response**: pushes `audio_buffer` binary event to the requesting client. Broadcasts `design_view_update` to peers.

### `sync_params` — Synth Parameter Sync (No Render)

Updates synthesizer parameters on the server without triggering an audio render. Used for live knob/slider adjustments where audio preview is not needed.

**Payload**: Same as `patch_update`.

**Server Response**: Broadcasts `design_view_update` to peers. No audio returned.

### `slider_update` — Mixer Control

Updates mixer state (track volume, mute, pan, EQ, master volume, transport). Broadcast to all other clients.

**Payload variants:**

```json
{"track_id": "track_1", "volume": 0.75}
{"track_id": "track_1", "muted": true}
{"track_id": "track_1", "eq_band": "low", "eq_value": 3.0}
{"master_volume": 0.9}
{"playing": true}
```

### `render_bar` — Polyphonic Bar Render

Renders a multi-note recording. Each note is rendered as a separate voice in a concurrent Elixir Task, then all voices are mixed by the Rust `mix_voices` NIF.

**Payload**

```json
{
  "notes": [
    { "frequency": 261.63, "start_ms": 0, "end_ms": 500 },
    { "frequency": 329.63, "start_ms": 200, "end_ms": 800 }
  ],
  "bar_duration_ms": 2000,
  "view_id": "design:alice"
}
```

**Server Response**: pushes `bar_audio` binary event.

### `note_preview` — Streaming Keyboard Note

Triggers a streaming voice for real-time keyboard preview. The server spawns a `VoiceStreamer` process that creates a persistent Rust `SynthVoice`, renders a 200 ms burst immediately, then streams 50 ms chunks every 50 ms.

**Payload**

```json
{
  "frequency": 440.0,
  "midi": 69,
  "view_id": "design:alice"
}
```

**Server Response**: Streams `voice_audio` binary events (burst + paced chunks) until key-up + release + effects tail decay.

### `key_up` — Key Release

Triggers the ADSR release phase on the active voice for the given MIDI note. The voice continues streaming the release tail and effects decay until voice culling threshold is reached.

**Payload**

```json
{ "midi": 69 }
```

**Server Response**: Voice continues streaming `voice_audio` events during release. Sends `voice_done` JSON when voice is fully done.

### `save_sample` — Save Recorded Sample

Saves a recorded sample to the database with its input history and generates waveform peaks.

**Payload**

```json
{
  "name": "Lead Synth",
  "genre": "electronic",
  "input_history": [
    {"midi": 60, "note": "C4", "frequency": 261.63, "start_ms": 0, "end_ms": 500}
  ],
  "bar_duration_ms": 4000,
  "bar_count": 2,
  "view_id": "design:alice"
}
```

### `start_playback` / `stop_playback` / `seek` — Timeline Transport

Controls timeline playback via `UserSession` burst & pace protocol.

```json
{"cursor_ms": 5000}
```

### `set_sync` — Audio Sync Toggle

Toggles per-view audio sync for collaborative listening.

```json
{"view_id": "design:alice", "enabled": true}
```

### `cursor_move` / `selection_update` — Collaboration

Real-time cursor and selection sharing between peers.

### `ping` — Health Check

**Reply**: `{:ok, %{message: "pong"}}`

---

## Events: Server → Client

### Binary Audio Events

| Event | Description | Trigger |
|---|---|---|
| `audio_buffer` | Synth render result (type 2) | `patch_update` response |
| `bar_audio` | Polyphonic bar render (type 2) | `render_bar` response |
| `voice_audio` | Streaming voice chunk (type 2, MIDI in byte 1) | `VoiceStreamer` burst + pace |
| `audio_frame` | Timeline playback chunk (type 1) | `UserSession` burst + pace |

### JSON Control Events

| Event | Description | Scope |
|---|---|---|
| `voice_done` | Voice finished (envelope done + effects silent) | requester |
| `slider_update` | Mixer change broadcast | all peers |
| `design_view_update` | Synth param change broadcast | all peers |
| `key_down` | Keyboard note press (user + color + midi) | all peers |
| `key_up` | Keyboard note release (user + midi) | all peers |
| `sync_update` | Audio sync toggle broadcast | all peers |
| `cursor_move` | Remote cursor position | all peers |
| `selection_update` | Remote timeline selection | all peers |
| `tracks_dragging` / `tracks_drag_end` | Track drag state | all peers |
| `presence_state` / `presence_diff` | User presence | all / joiner |

---

## Binary Wire Frame Format

All audio frames use this exact binary layout (Little Endian):

```
Offset       Size            JS Type            Content
─────────────────────────────────────────────────────────────
0            1 byte          Uint8              Message type ID (1=mixer, 2=synth)
1            1 byte          Uint8              MIDI note (voice_audio only, else 0)
2–3          2 bytes         —                  Zero padding (4-byte alignment)
4–515        512 bytes       Uint8Array(512)    FFT magnitude spectrum (0–255 per bin)
516+         N × 4 bytes     Float32Array(N)    PCM samples (−1.0 to 1.0)
```

### JavaScript Decoding

```typescript
const type = new Uint8Array(buffer, 0, 1)[0];
const midi = new Uint8Array(buffer, 1, 1)[0];  // for voice_audio only
const fft  = new Uint8Array(buffer, 4, 512);
const pcm  = new Float32Array(buffer, 516);
```

### Frame Sizes

| Duration | Samples (44.1 kHz) | PCM Bytes | Total Frame |
|---|---|---|---|
| 50 ms (pace chunk) | 2,205 | 8,820 | 9,336 bytes |
| 200 ms (burst) | 8,820 | 35,280 | 35,796 bytes |
| 1.0 s | 44,100 | 176,400 | 176,916 bytes |
| 3.0 s | 132,300 | 529,200 | 529,716 bytes |

### Design Constraints

- All audio data uses raw Little-Endian Float32. No compression (Opus, MP3) is applied.
- FFT spectrum is computed from the rendered PCM using a 512-point FFT with Hann windowing.
- PCM values are in the range [−1.0, 1.0]; a soft limiter (`tanh`) is applied during voice mixing.

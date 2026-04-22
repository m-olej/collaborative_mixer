# WebSocket Protocol

## Connection

**Endpoint**: `ws://localhost:4000/socket/websocket`

The frontend connects using the Phoenix JavaScript client library. The Vite dev server proxies `/socket` to `ws://localhost:4000`.

**Transport**: WebSocket only (long-polling disabled).

## Channel: `project:{project_id}`

Each project has its own channel topic. Joining a channel ensures the corresponding `SessionServer` GenServer is running and returns an initial state snapshot.

### Join

```
join "project:42"
```

**Reply** `{:ok, payload}`

```json
{
  "state": {
    "project_id": 42,
    "tracks": {},
    "master_volume": 1.0,
    "playing": false,
    "playhead_ms": 0,
    "synth_params": {
      "osc_shape": "saw",
      "frequency": 440.0,
      "unison_voices": 1,
      "unison_detune": 0.0,
      "unison_spread": 0.0,
      "cutoff": 5000.0,
      "resonance": 0.0,
      "filter_type": "svf",
      "drive": 1.0,
      "distortion_type": "off",
      "distortion_amount": 0.0,
      "lfo_rate": 1.0,
      "lfo_depth": 0.0,
      "lfo_shape": "sine",
      "lfo_target": "cutoff",
      "chorus_rate": 0.5,
      "chorus_depth": 0.0,
      "chorus_mix": 0.0,
      "reverb_decay": 0.3,
      "reverb_mix": 0.0,
      "volume": 0.8
    }
  }
}
```

---

## Events: Client → Server

### `patch_update` — Synth Parameter Update

Updates synthesizer parameters and triggers a full render. The server merges the incoming parameters with the current state, calls the Rust DSP NIF, and returns the rendered audio as a binary frame.

**Payload** (JSON — all fields optional, only changed values needed)

```json
{
  "osc_shape": "saw",
  "frequency": 440.0,
  "cutoff": 2500.0,
  "resonance": 0.7,
  "volume": 0.8
}
```

**Server Response**: pushes `audio_buffer` binary event to the requesting client.

### `slider_update` — Mixer Control

Updates mixer state (track volume, mute, EQ, master volume, transport). The change is broadcast to all other clients in the channel.

**Payload variants:**

```json
{"track_id": "track_1", "volume": 0.75}
{"track_id": "track_1", "muted": true}
{"track_id": "track_1", "eq_band": "low", "eq_value": 3.0}
{"master_volume": 0.9}
{"playing": true}
```

**Server Response**: broadcasts `slider_update` to all peers (not back to sender).

### `render_bar` — Polyphonic Bar Render

Renders a multi-note, multi-bar recording. Each note is rendered as a separate voice in a concurrent Elixir Task, then all voices are mixed by the Rust `mix_voices` NIF.

**Payload**

```json
{
  "notes": [
    {
      "frequency": 261.63,
      "start_ms": 0,
      "end_ms": 500
    },
    {
      "frequency": 329.63,
      "start_ms": 200,
      "end_ms": 800
    }
  ],
  "bar_duration_ms": 2000
}
```

- `notes` — array of note events with frequency, start time, and end time in milliseconds
- `bar_duration_ms` — total duration of the recording (may span multiple bars)

**Server Response**: pushes `bar_audio` binary event to the requesting client.

### `note_preview` — Keyboard Note Preview

Triggers a non-blocking render of a single note for real-time keyboard preview. Uses a cast + Task pattern so multiple notes can render concurrently (polyphonic preview).

**Payload**

```json
{
  "frequency": 440.0,
  "midi": 69
}
```

- `frequency` — note frequency in Hz
- `midi` — MIDI note number (0–127), embedded in byte 1 of the response for client-side correlation

**Server Response**: asynchronously pushes `note_audio` binary event.

### `save_sample` — Save Recorded Sample

Saves a recorded sample to the database with its input history.

**Payload**

```json
{
  "name": "Lead Synth",
  "genre": "electronic",
  "input_history": [
    {"midi": 60, "note": "C4", "frequency": 261.63, "start_ms": 0, "end_ms": 500}
  ],
  "bar_duration_ms": 4000,
  "bar_count": 2
}
```

**Reply** `{:ok, payload}` or `{:error, payload}`

```json
{"sample_id": 42, "name": "Lead Synth"}
```

### `ping` — Health Check

**Payload**: any

**Reply**: `{:ok, %{message: "pong"}}`

---

## Events: Server → Client

### `audio_buffer` — Synth Render Result

Binary frame containing the rendered audio from a `patch_update` request. Sent only to the requesting client.

**Format**: Binary wire frame (see below).

### `bar_audio` — Bar Render Result

Binary frame containing the polyphonically rendered bar from a `render_bar` request. Sent only to the requesting client.

**Format**: Binary wire frame (see below).

### `note_audio` — Note Preview Result

Binary frame containing a single-note preview render. The MIDI note number is embedded in byte 1 of the frame header for client-side correlation (allowing the client to associate the audio with a specific key press).

**Format**: Binary wire frame with MIDI in byte 1 (see below).

### `slider_update` — Mixer Change Broadcast

JSON event broadcast to all peers when a client updates a mixer control. The sender does not receive this event.

**Payload**: same structure as the incoming `slider_update` event.

---

## Binary Wire Frame Format

All audio frames flowing from server to client use this exact binary layout (Little Endian):

```
Offset       Size            JS Type            Content
─────────────────────────────────────────────────────────────
0            1 byte          Uint8              Message type ID
1            1 byte          Uint8              MIDI note (note_audio only, else 0)
2–3          2 bytes         —                  Zero padding (4-byte alignment)
4–515        512 bytes       Uint8Array(512)    FFT magnitude spectrum (0–255 per bin)
516+         N × 4 bytes     Float32Array(N)    PCM samples (−1.0 to 1.0)
```

### Message Type IDs

| ID | Usage |
|---|---|
| `1` | Mixer audio frame |
| `2` | Synthesizer audio frame |

### JavaScript Decoding

```typescript
// Decode a binary wire frame from an ArrayBuffer
const type = new Uint8Array(buffer, 0, 1)[0];
const midi = new Uint8Array(buffer, 1, 1)[0];  // for note_audio only
const fft  = new Uint8Array(buffer, 4, 512);
const pcm  = new Float32Array(buffer, 516);
```

### Frame Sizes

| Duration | Sample Rate | PCM Samples | PCM Bytes | Total Frame Size |
|---|---|---|---|---|
| 0.3 s | 44,100 Hz | 13,230 | 52,920 | 53,436 bytes |
| 1.0 s | 44,100 Hz | 44,100 | 176,400 | 176,916 bytes |
| 2.0 s | 44,100 Hz | 88,200 | 352,800 | 353,316 bytes |
| 3.0 s | 44,100 Hz | 132,300 | 529,200 | 529,716 bytes |

### Design Constraints

- All audio data uses raw Little-Endian Float32. No compression (Opus, MP3) is applied.
- FFT spectrum is computed from the rendered PCM using a 512-point FFT with Hann windowing.
- PCM values are in the range [−1.0, 1.0]; a soft limiter (`tanh`) is applied during voice mixing.

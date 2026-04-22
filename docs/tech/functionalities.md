# Project Functionalities

This document describes the user-facing features of Cloud DAW and how they work end-to-end.

---

## 1. Project Management

### Create a Project

Users create projects from the dashboard by providing a name and BPM (beats per minute).

**Flow**: UI form → `POST /api/projects` → project stored in PostgreSQL → appears in project list.

### Edit Project Settings

Inside a project, users can open the settings panel to modify:
- **BPM** (30–300)
- **Time signature** (4/4, 3/4, 6/8, 2/4, 5/4, 7/8)
- **Count-in note value** (quarter, eighth, sixteenth)

Changes are saved via `PUT /api/projects/:id` with optimistic locking (ETag/If-Match). If another user modified the project concurrently, the save fails with a conflict notification and the latest version is re-fetched.

### Delete a Project

Projects can be deleted from the dashboard. Cascading deletes remove associated tracks and exports.

---

## 2. Multi-User Collaboration

### Real-Time Session Sync

When a user opens a project, a WebSocket connection is established and a dedicated server-side session (GenServer) is created for that project. Multiple users can join the same session simultaneously.

**Initial sync**: On join, the client receives a full state snapshot (mixer levels, synth parameters, transport state).

**Live updates**: When any user adjusts a mixer control (volume fader, mute, EQ), the change is broadcast to all other users in the session via WebSocket. Each user's UI updates in real time.

### Server-Authoritative State

All state is owned by the server. Clients send control events; the server validates and applies them. This prevents conflicting state between users and ensures consistency.

---

## 3. Mixer

### Channel Strips

Each track in the mixer has:
- **Volume fader** (0.0–1.0) — controls the track's output level
- **Mute toggle** — silences the track
- **3-band EQ** — low, mid, and high frequency adjustments (±12 dB)

All mixer adjustments are sent to the server and broadcast to peers in real time.

### Master Bus

- **Master volume** — scales the final output level
- **Transport controls** — play/stop toggle
- **BPM display** — shows the project tempo

### FFT Spectrum Display

A canvas-based frequency spectrum visualizer renders 512 FFT bins using `requestAnimationFrame`. Bars are HSL-colored by frequency (low = red, mid = green, high = blue).

---

## 4. Synthesizer

### Sound Design

The synthesizer provides a comprehensive set of parameters for sound design:

**Oscillator**: 4 waveform shapes (saw, sine, square, triangle) with frequency control.

**Unison**: Up to 7 detuned oscillator voices with configurable detune (cents) and stereo spread.

**Filter**: Two filter types:
- SVF (state-variable filter) — clean, transparent
- Moog — warm, resonant, analog-style

Both have cutoff frequency and resonance controls.

**LFO**: Low-frequency oscillator modulating cutoff, pitch, or volume. 4 shapes (sine, triangle, square, saw) with rate and depth controls.

**Drive & Distortion**: Pre-filter drive (tanh saturation) and post-filter distortion (soft clip, hard clip, or arctan).

**Chorus**: Modulated delay-based effect with rate, depth, and mix controls.

**Reverb**: 4-tap feedback delay network with decay and mix controls.

**Volume**: Final output level.

### Render Sound

The "Render Sound" button triggers a full 1-second render on the server. The response includes:
- PCM audio (played back via the AudioWorklet ring buffer)
- FFT spectrum (displayed on the spectrum canvas)
- Waveform (displayed on the oscilloscope canvas)

Continuous parameter adjustments are debounced (150 ms) to avoid overwhelming the server.

### Keyboard Preview

A two-octave QWERTY piano keyboard (C3–B4, 24 keys) allows playing notes with the current synth sound:

- **Input**: keyboard (QWERTY layout) or mouse click
- **Sound generation**: Each key press sends a `note_preview` event to the server, which renders 3 seconds of audio at that note's frequency
- **Polyphony**: Multiple simultaneous key presses each spawn independent render tasks on the server — all notes play at the same time
- **Duration**: Notes play for as long as the key is held. On release, audio fades out smoothly (~45 ms)
- **Latency**: Sound begins playing when the server render completes (typically 10–50 ms on localhost)

---

## 5. Sample Recording

### Recording Workflow

The sample recorder implements a state machine for capturing keyboard performances:

```
1. Configure → 2. Count-in → 3. Record → 4. Render → 5. Review/Save
```

**Step 1 — Configure**: Select:
- Number of bars (1, 2, 3, 4, 6, or 8)
- Count-in grid (quarter, eighth, or sixteenth notes)

**Step 2 — Count-in**: A metronome plays one bar of clicks at the selected grid resolution. The metronome is generated client-side (1 kHz sine burst, 15 ms duration, exponential decay).

**Step 3 — Record**: The recording phase lasts for the configured number of bars. During this time:
- Keyboard note-on and note-off events are captured with millisecond timestamps
- Notes are recorded relative to the start of the recording (not the count-in)
- Open notes are automatically closed at the recording boundary

**Step 4 — Render**: The recorded note events are sent to the server, which:
- Spawns one concurrent Elixir Task per note
- Each Task calls the Rust DSP NIF to render that note's audio
- All voices are mixed via the Rust `mix_voices` NIF
- The combined audio (with FFT) is sent back as a binary frame

**Step 5 — Review and Save**:
- The piano roll visualizes the recorded notes
- The playback button plays the rendered audio
- Users can save the sample to the library with a name and genre tag

### Piano Roll

A canvas-based visualization of the recorded notes:

- **Vertical axis**: MIDI pitch (C3 at bottom to B4 at top)
- **Horizontal axis**: time within the recording
- **Note rectangles**: colored by pitch, showing exact start/end times
- **Grid lines**: subdivision lines at the count-in resolution, beat lines at quarter notes
- **Bar boundaries**: highlighted vertical lines for multi-bar recordings
- **Playback**: button feeds the rendered PCM to the audio system

---

## 6. Sample Library

### Browse Samples

The sample browser displays all saved samples in a paginated list (20 per page). Each entry shows:
- Sample name
- Genre tag (if set)
- Duration

Samples are fetched from `GET /api/samples?page=N&limit=20`.

### Save Samples

After recording and reviewing a sample in the design view, users can save it to the library by providing:
- **Name** (required)
- **Genre** (optional)

The save action stores:
- Sample metadata (name, genre, duration, bar count) in PostgreSQL
- Input history (array of note events with MIDI, frequency, timing) as JSONB
- An S3 key for the audio file in MinIO

### Delete Samples

Samples can be removed from the library via `DELETE /api/samples/:id`.

---

## 7. Audio Export

### Start Export

Users can initiate a WAV export of a project:

```
POST /api/projects/:id/exports?token=UUID
```

The token parameter ensures idempotency — retrying the same request does not create a duplicate export.

**Export states**:
- `pending` — export job accepted, processing
- `completed` — WAV file available for download
- `failed` — export encountered an error

### Export Idempotency

| Request | Server State | Response |
|---|---|---|
| First request with token X | No existing export | `202 Accepted` (created) |
| Retry with same token X | Export pending | `202 Accepted` (no duplicate) |
| Retry with same token X | Export completed | `303 See Other` (redirect to download) |

### Download Export

Completed exports can be retrieved via `GET /api/projects/:id/exports/:eid`. The response includes the export metadata and S3 key for the WAV file.

---

## 8. Track Management

### Merge Tracks

Multiple tracks can be merged into a single track via an atomic operation:

```
POST /api/projects/:id/actions/merge-tracks
{
  "track_ids": [1, 2, 3],
  "new_name": "Merged Track"
}
```

This runs inside a database transaction:
1. Validates all track IDs belong to the project
2. Creates a new merged track
3. Deletes the original tracks

If any step fails, the entire operation is rolled back.

---

## 9. Health Monitoring

### NIF Health Check

```
GET /api/ping
```

Verifies the Rust NIF is loaded and functional by calling `Backend.DSP.ping()`. Returns `{"status": "ok", "nif": "loaded"}`.

### Connection Status

The UI displays a connection indicator (green/red dot) showing the WebSocket connection state. Displayed alongside the project name and BPM in the tab bar.

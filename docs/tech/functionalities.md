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

**Initial sync**: On join, the client receives a full state snapshot (mixer levels, synth parameters for all design views, transport state).

**Live updates**: When any user adjusts a mixer control (volume fader, mute, EQ) or a synth parameter, the change is broadcast to all other users in the session via WebSocket. Each user's UI updates in real time.

### Multi-User Design Views

Each user in a session gets their own design view (`design:{username}`). Users can:
- See tabs for all other users' design views
- Click a tab to view (read-only) another user's synth settings and hear their sound
- Toggle audio sync to include another user's audio in the mix

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

A canvas-based frequency spectrum visualizer renders 512 FFT bins using `requestAnimationFrame`. Bars are HSL-colored by frequency (low = red, mid = green, high = blue). A companion oscilloscope shows the PCM waveform in real time.

---

## 4. Synthesizer

### Sound Design

The synthesizer provides 29 parameters for sound design, organized into groups:

**Oscillator**: 5 waveform shapes (saw, sine, square, triangle, noise) with frequency control.

**Unison**: Up to 7 detuned oscillator voices with configurable detune (cents) and stereo spread. Gain is normalized by √N to prevent volume spikes.

**Filter**: Four filter types:
- **SVF** — clean, transparent state-variable lowpass
- **Moog** — warm, resonant analog-style lowpass
- **Highpass** — removes frequencies below cutoff
- **Bandpass** — passes a band around cutoff

All have cutoff frequency and resonance controls.

**LFO**: Low-frequency oscillator modulating cutoff, pitch, or volume. 4 shapes (sine, triangle, square, saw) with rate and depth controls.

**Drive & Distortion**: Pre-filter drive (tanh saturation, gain 1–20) and post-filter distortion (soft clip, hard clip, or arctan).

**Chorus**: Modulated delay-based effect with rate, depth, and mix controls.

**Reverb**: 4-tap feedback delay network with decay and mix controls.

**Volume**: Final output level.

### ADSR Envelopes

Two independent ADSR envelopes shape each sound:

**Amplitude Envelope** — Controls volume over the note's lifetime:
- Attack (0–5000 ms): linear ramp from 0 to full volume
- Decay (0–5000 ms): exponential fall to sustain level
- Sustain (0–1): held level while key is pressed
- Release (0–5000 ms): exponential fade to silence after key release

**Filter Envelope** — Modulates the filter cutoff frequency:
- Same ADSR shape as amplitude envelope
- Envelope depth parameter controls how many Hz the cutoff sweeps
- Creates dynamic timbral movement (e.g., filter opens during attack, closes during decay)

Both envelopes are visualized with interactive canvas displays (linear attack, exponential decay/release curves) and per-parameter sliders. The amp envelope uses indigo accents; the filter envelope uses amber/yellow.

### Factory Presets

~15 curated presets organized by category:

| Category | Presets |
|---|---|
| Basses | 808 Sub Bass, Dubstep Wub Bass |
| Synths/Keys | Supersaw Chord, Synth Pluck |
| Pads | Cinematic Pad |
| Drums | Closed Hi-Hat, Synth Snare |

Presets are `Partial<SynthParams>` merged onto defaults. Selecting a preset updates the local view and syncs to the server and peers.

### Render Sound

The "Render Sound" button triggers a full 1-second render on the server. The response includes:
- PCM audio (played back via the AudioWorklet ring buffer)
- FFT spectrum (displayed on the spectrum canvas)
- Waveform (displayed on the oscilloscope canvas)

### Parameter Sync Strategy

Two separate message types handle synth parameter changes:

| Event | Trigger | Server Action | Debounce |
|---|---|---|---|
| `sync_params` | Slider/knob adjustment | Merge params, broadcast to peers, no render | 150 ms |
| `patch_update` | "Render Sound" button | Merge params, render audio, return binary | None |

This prevents unnecessary audio renders during live knob tweaking while keeping all clients in sync.

### Keyboard Preview (Streaming Voice)

A two-octave QWERTY piano keyboard with octave switching (range 0–7, default octave 3) allows playing notes with the current synth sound:

- **Input**: keyboard (QWERTY layout) or mouse click
- **Octave switching**: −Oct / +Oct buttons shift the entire keyboard range (C0–B1 through C7–B8)
- **Key mapping**: Lower octave `Z S X D C V G B H N J M`, upper octave `Q 2 W 3 E R 5 T 6 Y 7 U`

**Sound generation**: Each key press sends a `note_preview` event to the server, which spawns a `VoiceStreamer` process:

1. A persistent Rust `SynthVoice` is created with the current synth parameters and note frequency
2. An initial 200 ms audio burst is rendered and sent immediately
3. Every 50 ms, an additional 50 ms chunk is rendered and streamed to the client
4. Audio includes full signal chain: oscillators, filters, ADSR envelopes, effects

**Key release**: Sending `key_up` triggers the ADSR release phase on the server. The voice continues streaming the release tail and effects decay until the amplitude drops below the silence threshold (0.00001), then the voice is destroyed.

**Polyphony**: Multiple simultaneous key presses each get their own `VoiceStreamer` — all notes play concurrently with additive mixing on the client via `mixPcm()`.

**Re-trigger**: Pressing the same key while it's still sounding kills the old voice and spawns a new one.

**Collaboration**: Other users' currently-held keys are shown as colored dots on the keyboard.

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

**Step 4 — Render**: The recorded note events are sent to the server via `render_bar`, which:
- Spawns one concurrent Elixir Task per note
- Each Task calls the Rust DSP NIF to render that note's audio (with proper note-on/note-off ADSR)
- All voices are mixed via the Rust `mix_voices` NIF with tanh soft limiting
- The combined audio (with FFT) is sent back as a binary frame

**Step 5 — Review and Save**:
- The piano roll visualizes the recorded notes
- The playback button plays the rendered audio
- Users can save the sample to the library with a name and genre tag

### Piano Roll

A canvas-based visualization of the recorded notes:

- **Vertical axis**: MIDI pitch (C3 at bottom to B4 at top, 24 rows)
- **Horizontal axis**: time within the recording
- **Note rectangles**: colored by pitch, showing exact start/end times
- **Grid lines**: subdivision lines at the count-in resolution, beat lines at quarter notes
- **Bar boundaries**: highlighted vertical lines for multi-bar recordings
- **Playback**: button feeds the rendered PCM to the AudioWorklet

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
- Synth parameters snapshot as JSONB
- Audio PCM as a WAV in MinIO (S3)
- Waveform peaks for timeline display

### Drag to Timeline

Saved samples can be dragged from the sample browser onto timeline lanes, creating track clips at the drop position.

### Delete Samples

Samples can be removed from the library via `DELETE /api/samples/:id`. Both the database record and the S3 audio file are deleted.

---

## 7. Timeline Playback

### Audio Playback

Timeline playback uses the burst & pace protocol:

1. User clicks play → `start_playback` sent to server
2. Server renders 200 ms audio burst and sends immediately
3. Every 50 ms, server renders and sends a 50 ms chunk
4. All loaded tracks are mixed: overlapping clips are summed, per-track volume/mute applied
5. PCM + FFT binary frames are fed to the AudioWorklet for sequential playback

### Seeking

Clicking the ruler or dragging the playhead sends a `seek` event. If playing, playback restarts from the new position.

### Zoom & Snap

- **Zoom**: pixels per beat (scrollable)
- **Snap**: bar, beat, 1/8, 1/16, or free placement

---

## 8. Track Management

### Place Tracks

Samples from the library are placed on the timeline via drag-and-drop. The server:
1. Decodes the audio file (any format → mono f32 PCM via symphonia + rubato)
2. Memory-maps the decoded audio for zero-copy reads
3. Rebuilds the interval tree for fast time-range queries

### Move Tracks

Tracks can be moved along the timeline (time) or between lanes. Multi-select drag moves all selected tracks together via `batchMoveTracks`.

### Merge Tracks

Multiple tracks can be merged into a single track via an atomic operation:

```
POST /api/projects/:id/actions/merge-tracks
{ "track_ids": [1, 2, 3], "new_name": "Merged Track" }
```

This runs inside a database transaction:
1. Validates all track IDs belong to the project
2. Creates a new merged track
3. Deletes the original tracks
4. If any step fails, the entire operation is rolled back

---

## 9. Audio Export

### Start Export

Users can initiate a WAV export of a project:

```
POST /api/projects/:id/exports?token=UUID
```

The token parameter ensures idempotency — retrying the same request does not create a duplicate export.

**Export states**: `pending` → `completed` / `failed`.

### Export Idempotency

| Request | Server State | Response |
|---|---|---|
| First request with token X | No existing export | `202 Accepted` (created) |
| Retry with same token X | Export pending | `202 Accepted` (no duplicate) |
| Retry with same token X | Export completed | `303 See Other` (redirect to download) |

### Download Export

Completed exports can be retrieved via `GET /api/projects/:id/exports/:eid`.

---

## 10. Health Monitoring

### NIF Health Check

```
GET /api/ping
```

Verifies the Rust NIF is loaded and functional by calling `Backend.DSP.ping()`. Returns `{"status": "ok", "nif": "loaded"}`.

### Connection Status

The UI displays a connection indicator (green/red dot) showing the WebSocket connection state. Displayed alongside the project name and BPM in the tab bar.

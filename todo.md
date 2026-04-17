# Cloud DAW — Implementation Plan

## Status Key
- `[ ]` not started
- `[~]` in progress
- `[x]` done

---

## Phase 0 — Scaffolding (DONE)

- [x] Ecto migrations: projects, tracks, samples, exports
- [x] Ecto schemas + context modules (Projects, Samples, Exports)
- [x] REST controllers: ProjectController, SampleController, ExportController, PingController
- [x] Router with nested resources
- [x] Phoenix.Channel: UserSocket + ProjectChannel
- [x] GenServer: SessionServer (per-project mixer state) + SessionSupervisor (DynamicSupervisor)
- [x] Registry for session lookup
- [x] Rust NIF bridge: Backend.DSP + `ping` NIF
- [x] Frontend types (types/daw.ts)
- [x] Zustand stores: useSocketStore, useProjectStore
- [x] REST API client (api/rest.ts)
- [x] AudioWorklet ring-buffer processor (public/audio-processor.js)
- [x] Base UI components: ProjectList, MixerView, SpectrumCanvas
- [x] Vite proxy: /api + /socket → Phoenix :4000

---

## Phase 1 — Rust DSP Core

Priority: everything downstream (audio streaming, export) depends on these NIFs.

- [ ] **`generate_tone` NIF** — Generates a sine-wave WAV at a given frequency + duration.
      Used exclusively for seeding test data. Does NOT need to be DirtyCpu (fast, small files).
      Signature: `generate_tone(freq_hz, duration_ms, sample_rate) -> Vec<u8>` (raw WAV bytes)

- [ ] **`decode_audio_file` NIF** (`schedule = "DirtyCpu"`) — Decodes any audio file to
      normalized `Vec<f32>` PCM at 44100 Hz using `symphonia` + `rubato` resampling.
      Signature: `decode_audio_file(path: String) -> NifResult<Vec<f32>>`

- [ ] **`mix_and_stream` NIF** (`schedule = "DirtyCpu"`) — Takes a list of
      `{pcm: Vec<f32>, volume: f32, muted: bool, eq: EqSettings}` structs, a frame offset,
      and a frame size. Returns one binary WebSocket frame:
      `[u8 type=1, u8×3 padding, u8×512 FFT, f32×N PCM]` (Little Endian).
      Uses `biquad` for EQ, `rustfft` for spectrum.
      Signature: `mix_and_stream(tracks, frame_start, frame_size) -> NifResult<OwnedBinary>`

- [ ] **`render_wav` NIF** (`schedule = "DirtyCpu"`) — Renders the complete mix to a WAV
      file at a given path. Uses `hound` for writing, `tempfile` for atomic write.
      Signature: `render_wav(tracks, sample_rate, output_path) -> NifResult<String>`

- [ ] Register all new NIFs in `rustler::init!` in `lib.rs`
- [ ] Expose all NIFs as Elixir stubs in `lib/backend/dsp.ex`
- [ ] `cargo clippy -- -D warnings` passes with zero warnings

---

## Phase 2 — Audio Streaming Pipeline

The SessionServer becomes the mixer engine driving real-time playback.

- [ ] **Load tracks into SessionServer state** — On session start (or when a track is added),
      call `Backend.DSP.decode_audio_file/1` and store the decoded `Vec<f32>` in the GenServer
      state map keyed by track ID. Do this in an async `Task` to avoid blocking the caller.

- [ ] **Streaming loop** — Add a `:tick` message to SessionServer driven by
      `:timer.send_interval/2` (e.g. every 10ms for ~441 samples/frame at 44100 Hz).
      On each tick, call `mix_and_stream/3` with the current frame offset and broadcast
      the returned binary frame via `Phoenix.PubSub.broadcast/3`.

- [ ] **Play/Pause/Seek control** — Handle `handle_in("transport", ...)` in ProjectChannel.
      Cast to SessionServer: `{:set_transport, %{playing: bool, playhead_ms: int}}`.
      When `playing: false`, suppress ticks without cancelling the timer.

- [ ] **Advance playhead** — SessionServer increments `playhead_ms` by `frame_duration_ms`
      on each tick. When playhead exceeds project duration, stop playing and broadcast a
      `"playback_ended"` event.

- [ ] **Broadcast slider updates** — `handle_in("slider_update", ...)` already works.
      Wire it through to `SessionServer.update_slider/2` so EQ/volume changes are applied
      to the next `mix_and_stream` call without reloading PCM data.

---

## Phase 3 — MinIO / S3 File Storage

- [ ] **Bucket setup in seeds** — Ensure the `cloud-daw` MinIO bucket exists on startup.
      Create a `Backend.Storage` module wrapping ExAws operations.

- [ ] **`Backend.Storage.upload/3`** — Uploads a local file path to `bucket/key`.
      Returns `{:ok, key}` or `{:error, reason}`.

- [ ] **`Backend.Storage.delete/2`** — Deletes `bucket/key`.

- [ ] **`Backend.Storage.presigned_url/2`** — Returns a GET presigned URL (1-hour TTL).
      Used by SampleController.show and ExportController.show instead of proxying bytes.

- [ ] **SampleController.create** — Replace the placeholder s3_key logic with:
      1. Accept `multipart/form-data` with a `file` part.
      2. Write upload to a tempfile.
      3. Call `Backend.Storage.upload/3`.
      4. Insert Sample record with the real s3_key.

- [ ] **SampleController.delete** — After `Repo.delete`, call `Backend.Storage.delete/2`.

- [ ] **ExportController.show** — Content negotiation:
      - `Accept: audio/wav` → redirect to presigned URL (or stream bytes).
      - `Accept: application/json` → return export metadata JSON.

---

## Phase 4 — Async Export Pipeline

- [ ] **`Backend.Exports.run_export/1`** — Async `Task` (not a GenServer) that:
      1. Fetches all project tracks from DB.
      2. Decodes each track's audio via `Backend.DSP.decode_audio_file/1`.
      3. Calls `Backend.DSP.render_wav/3` (DirtyCpu NIF).
      4. Uploads result WAV to MinIO via `Backend.Storage.upload/3`.
      5. Calls `Backend.Exports.mark_completed/2` or `mark_failed/1`.

- [ ] **Wire into ExportController.create** — After `Exports.create_export/2`, spawn
      `Task.start(fn -> Backend.Exports.run_export(export) end)`.

- [ ] **ExportController.show** — Poll endpoint: return `202` if status is `:pending`,
      presigned URL redirect if `:completed`, `500` if `:failed`.

---

## Phase 5 — Track Management API

Currently tracks have no REST endpoints — they are managed implicitly.

- [ ] **TrackController** with: `index` (list for a project), `create`, `delete`
- [ ] Add nested resource to router: `resources "/tracks", TrackController, only: [...]`
      under `resources "/projects"`.
- [ ] `TrackController.create` — After insert, notify the running SessionServer (if alive)
      to load the new track's audio: `SessionServer.add_track/2`.
- [ ] `TrackController.delete` — Remove from DB; notify SessionServer to evict from state.
- [ ] **405 Method Not Allowed** — Add `match _ …` fallback clauses in the router for
      methods not listed in the requirements table (see `docs/api.md`).

---

## Phase 6 — Frontend Mixer UI

- [ ] **TrackStrip component** — One row per track showing:
      - Track name label
      - Volume fader (vertical `<input type="range">`, `useRef` for real-time update, sends
        `slider_update` to channel on `pointerup` only — not on every `change`)
      - Mute toggle button
      - VU meter bar (updated via `useRef` from `audio_update` event — NO `useState`)

- [ ] **EQ panel** — Three range inputs per track: Low / Mid / High gain (±12 dB).
      Send `eq_update` message to channel on release.

- [ ] **Transport bar** — Play ▶ / Stop ■ buttons, BPM display, playhead position readout
      (updated via `useRef` from WebSocket `state_update`).

- [ ] **Master volume fader** — Like track volume but sends `{master_volume: n}` update.

- [ ] **MixerLayout** — Arranges TrackStrips horizontally, TransportBar at top, Spectrum
      canvas below.

- [ ] **Wire binary frames to AudioWorklet** — In `useSocketStore`, intercept binary
      messages: decode via `decodeAudioFrame()`, call `feedPcm(frame.pcm)` from
      `useAudioWorklet`, call canvas `_updateFft(frame.fft)`.

- [ ] **AudioWorklet init on first interaction** — Call `useAudioWorklet().init()` on a
      user gesture (e.g. Play button click) since `AudioContext` requires user activation.

---

## Phase 7 — Frontend Sample Browser & Upload

- [ ] **SampleBrowser component** — Paginated list (prev/next), search by genre.
      Uses `api.listSamples(page, limit)`. Each row shows name, genre, duration.

- [ ] **Upload form** — `<input type="file" accept="audio/*">` + name/genre fields.
      Uses `FormData` POST to `/api/samples`. Shows progress via `fetch` + `ReadableStream`.

- [ ] **Drag sample to track** — Drag a Sample onto a TrackStrip to call
      `POST /api/projects/:id/tracks` assigning the sample's s3_key.

---

## Phase 8 — Frontend Project Management Polish

- [ ] **Project settings panel** — Edit name and BPM. Fetches current ETag on open,
      sends `PUT /api/projects/:id` with `If-Match` header. Surfaces 412 conflict error.

- [ ] **Merge tracks dialog** — Checkbox-select two or more tracks, confirm, call
      `POST /api/projects/:id/actions/merge-tracks`. Reloads track list on success.

- [ ] **Export button** — Generates `crypto.randomUUID()` token (persisted in Zustand),
      calls `api.startExport()`. Polls `GET /api/projects/:id/exports/:eid` every 3s
      until status is `completed`, then offers a download link.

---

## Phase 9 — Quality, Tests & Hardening

- [ ] **Controller tests** — ExUnit tests for all REST endpoints covering:
      - Happy paths (200/201/204)
      - 404 not found
      - 412 / 428 for PUT without / with wrong ETag
      - 202 / 303 for idempotent export replay
      - Pagination boundary (page > total pages → empty data array)

- [ ] **Channel tests** — `use BackendWeb.ChannelCase`. Test join, slider_update broadcast,
      ping/pong.

- [ ] **Context unit tests** — `merge_tracks` rollback on missing track IDs,
      `find_by_token` uniqueness.

- [ ] **`mix precommit` clean** — Zero warnings, zero failures throughout.

- [ ] **Frontend: error boundaries** — Wrap MixerView in a React error boundary to prevent
      WebSocket errors from crashing the whole app.

---

## Test Data Strategy

### Goal
Run the application without real audio files, demonstrate all features end-to-end.

### Approach: Synthetic Audio via Rust + Seeds

The Rust NIF `generate_tone/3` (Phase 1) generates sine-wave WAV files from pure math
— no external assets required.

**`priv/repo/seeds.exs` plan:**

```
Project "Demo Session" (BPM: 120)
  Track 1 "Bass Drum"   → 60 Hz tone,  2000 ms
  Track 2 "Snare"       → 200 Hz tone, 2000 ms
  Track 3 "Hi-Hat"      → 800 Hz tone, 2000 ms
  Track 4 "Pad"         → 440 Hz tone, 4000 ms  (A4 — recognizable pitch)

Project "Ambient Test" (BPM: 80)
  Track 1 "Sub"         → 40 Hz tone,  8000 ms
  Track 2 "Lead"        → 523 Hz tone, 4000 ms  (C5)

Sample Library (10 entries)
  808 Kick  → 55 Hz,  500 ms
  Clap      → 300 Hz, 250 ms
  Shaker    → 1200 Hz, 200 ms
  … etc.
```

**Seed execution flow:**
1. Call `Backend.DSP.generate_tone(freq, duration_ms, 44100)` → raw WAV `binary`.
2. Write binary to a tempfile path.
3. Call `Backend.Storage.upload("cloud-daw", "seeds/#{key}.wav", tempfile_path)`.
4. Insert DB records pointing to that s3_key.
5. Ensure the MinIO bucket `cloud-daw` exists before uploading (create if absent).

**Why synthetic tones:**
- No copyright concerns.
- Deterministic output (same seed always produces the same state).
- Each frequency visibly separates on the FFT spectrum canvas, making the
  visualizer immediately impressive in a demo.
- Small file sizes (< 200 KB each) — seeds run in < 5 seconds total.

### Running the Seeds

```bash
# Reset DB and regenerate fresh demo data
cd backend
mix ecto.reset    # drop + create + migrate + seeds
```

### Manual Test Checklist (Post-Seeds)

After `docker compose up -d && mix phx.server` + `npm run dev`:

1. **WebSocket join** — Open a project; browser console shows "Connected to session".
2. **FFT canvas** — Canvas draws colored bars as audio plays (separate frequencies visible).
3. **Volume fader** — Move fader; bar height updates without page rerender.
4. **Multi-user** — Open two browser tabs on the same project; move a fader in one,
   observe it move in the other (broadcast confirmed).
5. **ETag conflict** — Open two tabs; edit BPM in both; save first tab (200 OK);
   save second tab without refreshing (412 response).
6. **Idempotent export** — Click Export twice rapidly; both requests return 202 (no
   duplicate Rust invocations).
7. **Pagination** — `/api/samples?page=1&limit=3` returns 3 items; `page=2` returns next 3.
8. **Merge tracks** — Select 2 tracks, merge; track count decreases by 1.
9. **DSP ping** — `GET /api/ping` returns `{"dsp":"Rust DSP Engine is online!"}`.

# Cloud DAW — Backend Agent Guide

> Elixir/Phoenix application. Read root `AGENTS.md` first for cross-cutting concerns.
> Run `mix precommit` before finishing any change set (compile warnings-as-errors + format + test).

---

## 1. Application Identity

| Key             | Value                                  |
|-----------------|----------------------------------------|
| OTP app name    | `:backend`                             |
| Phoenix version | 1.8.x                                  |
| Elixir version  | `~> 1.15`                              |
| HTTP adapter    | Bandit (not Cowboy)                    |
| JSON library    | Jason                                  |
| DB adapter      | Postgrex / `Ecto.Adapters.Postgres`    |
| Repo module     | `Backend.Repo`                         |
| Web module      | `BackendWeb`                           |

---

## 2. Module Map

```
lib/
├── backend.ex
├── backend_web.ex
├── backend/
│   ├── application.ex              ← OTP supervision tree
│   ├── repo.ex                     ← Ecto.Repo (PostgreSQL)
│   ├── dsp.ex                      ← NIF bridge to Rust DSP engine
│   ├── projects.ex                 ← Context: Project + Track CRUD + ETag + merge
│   ├── samples.ex                  ← Context: Sample CRUD + paginated list
│   ├── exports.ex                  ← Context: Export CRUD + token lookup
│   ├── projects/
│   │   ├── project.ex              ← Ecto schema (id, name, bpm, time_signature, count_in_note_value)
│   │   └── track.ex                ← Ecto schema (id, name, s3_key, position_ms, lane_index, lock_version, project_id)
│   ├── samples/
│   │   └── sample.ex               ← Ecto schema (id, name, genre, s3_key, duration_ms, input_history, bar_count, waveform_peaks)
│   ├── exports/
│   │   └── export.ex               ← Ecto schema (id, token, status, project_id)
│   └── daw_session/
│       ├── session_server.ex       ← GenServer: per-project mixer + synth state
│       ├── session_supervisor.ex   ← DynamicSupervisor managing session servers
│       ├── user_session.ex         ← GenServer: per-user playback pacing + sync
│       ├── user_session_supervisor.ex ← DynamicSupervisor managing user sessions
│       └── voice_streamer.ex       ← GenServer: per-voice streaming audio (burst & pace)
└── backend_web/
    ├── endpoint.ex                 ← Plug pipeline, WebSocket socket mount
    ├── router.ex                   ← HTTP route definitions
    ├── telemetry.ex
    ├── gettext.ex
    ├── channels/
    │   ├── user_socket.ex          ← Phoenix.Socket mount
    │   ├── project_channel.ex      ← Real-time WebSocket channel
    │   └── presence.ex             ← Phoenix.Presence tracker
    └── controllers/
        ├── ping_controller.ex
        ├── project_controller.ex
        ├── track_controller.ex
        ├── sample_controller.ex
        ├── export_controller.ex
        └── error_json.ex
```

---

## 3. Supervision Tree

```
Backend.Supervisor (one_for_one)
├── BackendWeb.Telemetry
├── Backend.Repo
├── {DNSCluster, ...}
├── {Phoenix.PubSub, name: Backend.PubSub}
├── BackendWeb.Presence
├── {Registry, keys: :unique, name: Backend.SessionRegistry}
├── Backend.DawSession.SessionSupervisor     ← DynamicSupervisor (ProjectSession)
├── Backend.DawSession.UserSessionSupervisor ← DynamicSupervisor (UserSession)
└── BackendWeb.Endpoint
```

`Backend.SessionRegistry` is keyed by `project_id` (integer). Session lookup uses `GenServer.whereis(via(project_id))`.

---

## 4. REST Routes

```elixir
scope "/api", BackendWeb do
  pipe_through :api   # plug :accepts, ["json"]

  get "/ping", PingController, :index

  resources "/projects", ProjectController, except: [:new, :edit] do
    post "/actions/merge-tracks", ProjectController, :merge_tracks
    resources "/exports", ExportController, only: [:index, :show, :create, :delete]
    resources "/tracks",  TrackController,  only: [:index, :show, :create, :update, :delete]
  end

  resources "/samples", SampleController, except: [:new, :edit, :update]
end
```

### HTTP Status Conventions

| Code | When                                                         |
|------|--------------------------------------------------------------|
| 201  | Resource created                                             |
| 202  | Export accepted (job queued or already running)             |
| 204  | Successful DELETE                                           |
| 303  | Export already completed — `Location` header set            |
| 404  | Resource not found                                          |
| 412  | `If-Match` does not match current ETag                      |
| 422  | Changeset validation failure                                |
| 428  | `If-Match` header missing on PUT                            |

---

## 5. ETag / Optimistic Locking

Both **Projects** and **Tracks** support optimistic locking via `If-Match`.

```elixir
# Backend.Projects — ETag generation
def etag(%Project{id: id, updated_at: ts}) do
  :crypto.hash(:md5, "#{id}:#{DateTime.to_iso8601(ts)}")
  |> Base.encode16(case: :lower)
end

def track_etag(%Track{id: id, updated_at: ts}) do
  :crypto.hash(:md5, "track:#{id}:#{DateTime.to_iso8601(ts)}")
  |> Base.encode16(case: :lower)
end
```

Controller pattern for PUT (same for projects and tracks):

```elixir
def update(conn, %{"id" => id} = params) do
  raw_etag = get_req_header(conn, "if-match") |> List.first()

  with {:etag_present, etag} when etag != nil <- {:etag_present, raw_etag},
       etag = String.trim(etag, "\""),
       {:ok, record} <- Context.get_resource(id),
       :ok <- Context.verify_etag(record, etag),
       {:ok, updated} <- Context.update_resource(record, params["resource"] || %{}) do
    conn
    |> put_resp_header("etag", "\"#{Context.etag(updated)}\"")
    |> json(%{data: resource_json(updated)})
  else
    {:etag_present, nil} -> send_resp(conn, 428, "")
    {:error, :not_found} -> send_resp(conn, 404, "")
    {:error, :etag_mismatch} -> send_resp(conn, 412, "")
    {:error, %Ecto.Changeset{} = cs} -> conn |> put_status(422) |> json(%{errors: format_errors(cs)})
  end
end
```

---

## 6. GenServer: `Backend.DawSession.ProjectSession`

Holds live **mixer + synthesizer** state for a single project, plus the Rust timeline engine. State is volatile (RAM only). Formerly `SessionServer`.

### State shape

```elixir
%{
  project_id: integer(),
  engine: reference(),        # Rust ResourceArc<ProjectEngine>
  tracks_loaded: MapSet.t(),  # track IDs loaded into engine
  active_users: %{},          # username => channel_pid
  # Mixer
  tracks: %{},             # track_id => mixer params
  master_volume: 1.0,
  playing: false,
  playhead_ms: 0,
  # Synthesizer — per-design-view state (atom-keyed maps passed directly to NIF)
  design_views: %{
    "design:alice" => %{
      synth_params: %{
        osc_shape: "saw", frequency: 440.0,
        unison_voices: 1, unison_detune: 0.0, unison_spread: 0.0,
        cutoff: 5000.0, resonance: 0.0, filter_type: "svf",
        drive: 1.0, distortion_type: "off", distortion_amount: 0.0,
        lfo_rate: 1.0, lfo_depth: 0.0, lfo_shape: "sine", lfo_target: "cutoff",
        chorus_rate: 0.5, chorus_depth: 0.0, chorus_mix: 0.0,
        reverb_decay: 0.3, reverb_mix: 0.0,
        volume: 0.8,
        amp_attack_ms: 10.0, amp_decay_ms: 100.0, amp_sustain: 0.8, amp_release_ms: 200.0,
        filter_attack_ms: 10.0, filter_decay_ms: 200.0, filter_sustain: 0.5,
        filter_release_ms: 300.0, filter_env_depth: 2000.0
      }
    }
  },
  last_bar_render: nil | {:ok, binary()},
  last_bar_duration_ms: nil | number(),
  last_bar_notes: nil | list()
}
```

### Public API

| Function                                         | Call type    | Purpose                                                        |
|--------------------------------------------------|--------------|----------------------------------------------------------------|
| `ensure_started(project_id)`                     | —            | Idempotent start via DynamicSupervisor                        |
| `get_state(project_id)`                          | `call`       | Full snapshot returned on channel join                         |
| `update_slider(project_id, params)`              | `cast`       | Mixer fader/EQ; fire-and-forget + sync to Rust engine         |
| `get_synth_params(project_id)`                   | `call`       | Current synth params (for save_sample)                        |
| `get_last_bar_render(project_id)`                | `call`       | Raw PCM binary from last bar render (for waveform peaks)      |
| `patch_and_render(project_id, raw_params)`       | `call` ∞     | Merge synth params, call Rust NIF, return `{:ok, binary}`     |
| `sync_params(project_id, view_id, raw_params)`    | `call`       | Merge synth params without rendering (live slider sync)       |
| `render_bar(project_id, notes, bar_duration_ms)` | `call` ∞     | Spawn concurrent voice tasks, mix via NIF, return wire frame  |
| `render_note_preview(project_id, freq, dur, midi, reply_pid)` | `cast` | Fire-and-forget; sends `{:note_audio, binary, midi}` to reply_pid |
| `mix_chunk(project_id, start_ms, duration_ms)`   | `call`       | Delegate to Rust engine; returns `{:ok, binary}` wire frame   |
| `register_user(project_id, username, pid)`       | `cast`       | Track active user in session                                   |
| `unregister_user(project_id, username)`          | `cast`       | Remove user from session                                       |
| `rebuild_timeline(project_id)`                   | `cast`       | Rebuild Rust interval tree from DB                             |

`call` with `:infinity` timeout is correct for render calls since the DirtyCpu NIF may take tens–hundreds of ms.

### Polyphonic Bar Render Flow

```
render_bar/3 call
    ↓ Spawn one Task.async per note (each calls render_voice_pcm NIF on DirtyCpu thread)
    ↓ Task.await_many(tasks, :infinity) — true parallel rendering
    ↓ Collect {pcm_binary, start_sample} per voice
    ↓ Backend.DSP.mix_voices(pcm_binaries, offsets, total_samples)
    ↓ Returns wire frame binary (header + FFT + mixed PCM)
```

---

## 6b. GenServer: `Backend.DawSession.UserSession`

Per-user session managing audio delivery, sync preferences, and timeline playback pacing.

### State shape

```elixir
%{
  project_id: integer(),
  username: String.t(),
  channel_pid: pid() | nil,
  sync_by_view: %{view_id => boolean()},
  cursor_ms: non_neg_integer(),
  playing: boolean(),
  timer_ref: reference() | nil,
  playback_view_id: String.t()
}
```

### Burst & Pace Protocol

1. `start_playback(cursor_ms, view_id)` → 200 ms pre-roll burst → `:timer.send_interval(50, :push_chunk)`.
2. Each `:push_chunk` tick calls `ProjectSession.mix_chunk/3` and forwards binary to channel.
3. `seek(cursor_ms)` → cancel timer → new burst → restart timer.
4. `stop_playback` → cancel timer, set playing = false.

### Registration

Via `Backend.SessionRegistry` keyed by `{:user, project_id, username}`.
Managed by `Backend.DawSession.UserSessionSupervisor` (DynamicSupervisor).

---

## 6c. GenServer: `Backend.DawSession.VoiceStreamer`

Per-voice process for streaming keyboard note preview. Each active note gets its own `VoiceStreamer`. Not supervised (temporary process, spawned directly by the channel).

### Lifecycle

1. `start_link(channel_pid, midi, synth_params, frequency)` — creates Rust `SynthVoice` via NIF
2. **Burst**: immediately renders 200 ms (8820 samples) → sends `{:voice_audio, midi, binary}` to channel
3. **Pace**: starts 50 ms timer → each tick renders 2205 samples → sends `{:voice_audio, midi, binary}`
4. **Note off**: channel sends `:note_off` cast → calls `voice_note_off` NIF → ADSR enters release phase
5. **Done**: when `voice_is_done` returns true → sends `{:voice_done, midi}` → process exits

### Constants

```elixir
@sample_rate 44_100
@burst_ms 200
@pace_ms 50
@burst_samples 8820
@pace_samples 2205
```

---

## 7. Phoenix Channel: `BackendWeb.ProjectChannel`

Topic: `"project:{project_id}"` (integer ID).

### Join flow
1. Parse and validate `project_id`.
2. `ProjectSession.ensure_started(id)` — idempotent.
3. `ProjectSession.get_state(id)` → sent as `{state: %MixerState{}}` in join reply.
4. Assign `:project_id`, `:username`, `:user_color` on the socket.
5. Start `UserSession` for this user via `UserSessionSupervisor`.
6. Register user in `ProjectSession` and set channel pid.
7. Send `self()` `:after_join` to track Presence.

### Incoming events handled

| Event           | Routed to                                    | Response                                          |
|-----------------|----------------------------------------------|---------------------------------------------------|
| `patch_update`  | `ProjectSession.patch_and_render/2`          | Push `audio_buffer` binary to requesting socket  |
| `slider_update` | `ProjectSession.update_slider/2` + `broadcast_from!/3` | Broadcasts to peers; noreply to sender |
| `render_bar`    | `ProjectSession.render_bar/3`                | Push `bar_audio` binary to requesting socket     |
| `note_preview`  | Spawns `VoiceStreamer` GenServer                 | Streams `voice_audio` binary + `voice_done` JSON |
| `key_up`        | Sends `:note_off` to `VoiceStreamer`             | Voice continues release tail then stops          |
| `sync_params`   | `ProjectSession.sync_params/3`                   | Broadcasts `design_view_update` to peers; no render |
| `start_playback`| `UserSession.start_playback/4`               | Triggers burst & pace protocol                   |
| `stop_playback` | `UserSession.stop_playback/2`                | Cancels pacing timer                              |
| `seek`          | `UserSession.seek/4`                         | Cancel + re-burst from new position               |
| `save_sample`  | `get_last_bar_render` + DSP peaks + `Samples.create_sample` | Push `sample_saved` / `sample_error` |
| `ping`         | inline                                       | Reply `{:ok, %{pong: true}}`                     |

### Outgoing server-push events

| Event            | Payload                  | Scope        | Trigger                          |
|------------------|--------------------------|--------------|----------------------------------|
| `audio_buffer`   | `{:binary, frame}`       | requester    | `patch_update` response          |
| `bar_audio`      | `{:binary, frame}`       | requester    | `render_bar` response            |
| `note_audio`     | `{:binary, frame}`       | requester    | `note_preview` async result (legacy) |
| `voice_audio`    | `{:binary, frame}`       | requester    | `VoiceStreamer` streaming chunks     |
| `voice_done`     | `%{midi: n}`             | requester    | `VoiceStreamer` finished             |
| `design_view_update` | `%{view_id, synth_params}` | all peers | `patch_update`/`sync_params` broadcast |
| `slider_update`  | JSON mixer params        | all peers    | `slider_update` broadcast        |
| `track_placed`   | `%{track: track_json}`   | all          | `TrackController.create/2`       |
| `track_moved`    | `%{track: track_json}`   | all          | `TrackController.update/2`       |
| `track_removed`  | `%{track_id: id}`        | all          | `TrackController.delete/2`       |
| `presence_state` | Presence map             | joiner       | Phoenix.Presence automatic       |
| `presence_diff`  | `{joins, leaves}`        | all          | Phoenix.Presence automatic       |
| `cursor_move`    | `%{user, color, x, y}`  | all peers    | `handle_in("cursor_move")`       |
| `selection_update`| `%{user, color, selection}` | all peers | `handle_in("selection_update")` |
| `sample_saved`   | `%{sample: sample_json}` | requester    | `save_sample` success            |
| `sample_error`   | `%{reason: string}`      | requester    | `save_sample` failure            |

---

## 8. NIF Bridge: `Backend.DSP`

All stubs raise `:nif_not_loaded` until the Rustler `.so` is loaded at boot.

```elixir
use Rustler, otp_app: :backend, crate: "backend_dsp"
```

| Function                                          | Schedule   | Returns                          |
|---------------------------------------------------|------------|----------------------------------|
| `ping/0`                                          | default    | `String.t()`                     |
| `generate_tone/3`                                 | default    | `[float()]`                      |
| `render_synth/2`                                  | DirtyCpu   | `binary()` (wire frame, type 2)  |
| `render_voice_pcm/2`                              | DirtyCpu   | `binary()` (raw f32 LE PCM)      |
| `mix_voices/3`                                    | DirtyCpu   | `binary()` (wire frame, type 2)  |
| `generate_waveform_peaks/2`                       | DirtyCpu   | `[{float, float}]`               |
| `init_engine/1`                                   | default    | `reference()` (ResourceArc)      |
| `decode_and_load_track/5`                         | DirtyCpu   | `:ok`                             |
| `rebuild_timeline/2`                              | default    | `:ok`                             |
| `set_track_params/2`                              | default    | `:ok`                             |
| `mix_chunk/3`                                     | DirtyCpu   | `binary()` (wire frame, type 1)  |
| `create_synth_voice/2`                            | default    | `reference()` (ResourceArc)      |
| `render_voice_chunk/2`                            | default    | `binary()` (wire frame, type 2)  |
| `voice_note_off/1`                                | default    | `:ok`                             |
| `voice_is_done/1`                                 | default    | `boolean()`                       |

`render_synth/2` takes `(synth_params_map, duration_secs)` where `synth_params_map` has **atom keys** and **29 fields** (the `ProjectSession` maintains this map with atom keys).

`create_synth_voice/2` takes `(synth_params_map, frequency)` and returns a ResourceArc wrapping a persistent `SynthVoice`.

`render_voice_chunk/2` takes `(voice_ref, num_samples)` and returns a wire frame (header + FFT + PCM).

`generate_waveform_peaks/2` takes `(pcm_binary, num_bins)` and returns `[{min, max}]` tuples.

---

## 9. Security Rules

- **Never** pass user-supplied strings to `String.to_atom/1` — use `String.to_existing_atom/1` or keep as strings.
- Fields set programmatically (`project_id`, `s3_key` derived from slug) must NOT appear in Ecto `cast/2` param lists.
- S3 path slugification strips non-alphanumeric characters: `String.replace(~r/[^a-z0-9]+/, "_")`.
- ETag values from `If-Match` are trimmed of surrounding quotes before comparison.

---

## 10. Idempotent Export Pattern

```elixir
# ExportController.create/2
case Exports.find_by_token(token) do
  nil ->
    {:ok, _export} = Exports.create_export(project_id, token)
    # TODO: spawn async DSP render task
    send_resp(conn, 202, "")

  %{status: "completed"} = export ->
    conn
    |> put_resp_header("location", ~p"/api/projects/#{project_id}/exports/#{export.id}")
    |> send_resp(303, "")

  %{status: _pending_or_failed} ->
    send_resp(conn, 202, "")
end
```

The async render task (spawning Rust `render_wav` NIF) is **not yet implemented** — tracked as TODO in `ExportController`.

---

## 11. Merge Tracks (Atomic)

`Projects.merge_tracks/3` runs inside `Repo.transaction/1`:
1. Fetch all requested tracks — rollback with `:tracks_not_found` if count mismatch.
2. Insert new merged track (s3_key is a placeholder — actual S3 merge is a TODO).
3. `Repo.delete_all` the source tracks.
4. Return the new track.

---

## 12. Validation Commands

```bash
cd backend
mix precommit     # compile --warnings-as-errors + mix format --check-formatted + mix test
mix ecto.migrate  # apply pending migrations
```

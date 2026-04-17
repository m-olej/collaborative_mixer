# Cloud DAW — Backend Agent Guide

> Elixir/Phoenix application. Read root `AGENTS.md` first for cross-cutting concerns.
> Run `mix precommit` before finishing any change set (compile warnings-as-errors + format + test).

---

## 1. Application Identity

| Key           | Value                        |
|---------------|------------------------------|
| OTP app name  | `:backend`                   |
| Phoenix version | 1.8.5                      |
| Elixir version | `~> 1.15`                   |
| HTTP adapter  | Bandit (not Cowboy)          |
| JSON library  | Jason                        |
| DB adapter    | Postgrex / Ecto.Adapters.Postgres |
| Repo module   | `Backend.Repo`               |
| Web module    | `BackendWeb`                 |

---

## 2. Module Map

```
lib/
├── backend.ex                     ← domain root module (context docs)
├── backend/
│   ├── application.ex             ← OTP Application, supervision tree
│   └── repo.ex                    ← Ecto.Repo (PostgreSQL)
└── backend_web/
    ├── backend_web.ex             ← use macros (:controller, :channel, :router)
    ├── endpoint.ex                ← Plug pipeline, WebSocket socket mounts
    ├── router.ex                  ← HTTP route definitions
    ├── gettext.ex                 ← i18n
    ├── telemetry.ex               ← Phoenix.Telemetry metrics
    └── controllers/
        └── error_json.ex          ← JSON error renderer
```

**Planned additions (not yet created):**

```
lib/backend/
├── projects/                      ← context: Project, Track schemas + queries
├── samples/                       ← context: Sample schema + MinIO integration
├── exports/                       ← context: Export schema + job tracking
└── daw_session/
    ├── session_server.ex          ← GenServer: per-project live mixer state
    └── session_supervisor.ex      ← DynamicSupervisor managing session servers

lib/backend_web/
├── channels/
│   └── project_channel.ex        ← Phoenix.Channel for WebSocket rooms
└── controllers/
    ├── project_controller.ex
    ├── sample_controller.ex
    └── export_controller.ex
```

---

## 3. Supervision Tree

Current (bootstrapped):

```
Backend.Supervisor (one_for_one)
├── BackendWeb.Telemetry
├── Backend.Repo
├── {DNSCluster, ...}
├── {Phoenix.PubSub, name: Backend.PubSub}
└── BackendWeb.Endpoint
```

Planned additions:

```
├── {Registry, keys: :unique, name: Backend.SessionRegistry}
└── Backend.DawSession.SessionSupervisor  ← DynamicSupervisor
```

---

## 4. GenServer: Live Mixer Sessions

Each active project has one `Backend.DawSession.SessionServer` process.

### State shape (proposed)

```elixir
%{
  project_id: integer(),
  tracks: %{track_id => %{volume: float(), muted: boolean(), eq: map()}},
  bpm: integer(),
  playhead_ms: non_neg_integer()
}
```

### Key rules

- Start via `DynamicSupervisor.start_child/2` on first WebSocket join.
- Register in `Backend.SessionRegistry` keyed by `project_id` for lookup.
- **Never** write GenServer state to the database on every tick — only on explicit user save action via REST.
- `GenServer.call/3` for state reads (synchronous, returns value).
- `GenServer.cast/2` for slider/EQ updates (fire-and-forget, then broadcast).

### Broadcast pattern

```elixir
Phoenix.PubSub.broadcast(Backend.PubSub, "project:#{id}", {:state_update, payload})
```

---

## 5. Phoenix Channels (WebSocket)

Channel module: `BackendWeb.ProjectChannel` (to be created).

```elixir
defmodule BackendWeb.ProjectChannel do
  use BackendWeb, :channel

  def join("project:" <> project_id, _payload, socket) do
    # Fetch initial state from SessionServer, assign project_id
  end

  # Binary audio frames come FROM Rust → Elixir → broadcast here
  def handle_info({:audio_frame, binary}, socket) do
    push(socket, "audio_frame", {:binary, binary})
    {:noreply, socket}
  end
end
```

Socket mount goes in `endpoint.ex`:

```elixir
socket "/socket", BackendWeb.UserSocket,
  websocket: true,
  longpoll: false
```

---

## 6. REST Controllers

All controllers live under `lib/backend_web/controllers/`. Use `use BackendWeb, :controller`.

### Router scope

```elixir
scope "/api", BackendWeb do
  pipe_through :api   # plug :accepts, ["json"]

  resources "/projects", ProjectController, except: [:new, :edit] do
    post "/actions/merge-tracks", ProjectController, :merge_tracks
    resources "/exports", ExportController, only: [:index, :show, :create, :delete]
  end

  resources "/samples", SampleController, except: [:new, :edit, :update]
end
```

### ETag / Optimistic Locking (PUT /projects/:id)

```elixir
def update(conn, %{"id" => id} = params) do
  with etag when not is_nil(etag) <- get_req_header(conn, "if-match") |> List.first(),
       {:ok, project} <- Projects.get_project(id),
       :ok <- Projects.verify_etag(project, etag),
       {:ok, updated} <- Projects.update_project(project, params) do
    conn
    |> put_resp_header("etag", Projects.etag(updated))
    |> json(updated)
  else
    nil -> send_resp(conn, 428, "")          # Precondition Required
    {:error, :etag_mismatch} -> send_resp(conn, 412, "")
    {:error, changeset} -> # 422
  end
end
```

Generate ETags from the record's `updated_at` timestamp + id:

```elixir
def etag(%Project{id: id, updated_at: ts}), do: :crypto.hash(:md5, "#{id}#{ts}") |> Base.encode16()
```

### Idempotent Export (POST /projects/:id/exports?token=UUID)

```elixir
def create(conn, %{"id" => project_id, "token" => token}) do
  case Exports.find_by_token(token) do
    nil ->
      {:ok, export} = Exports.create_export(project_id, token)
      Task.start(fn -> Backend.DSP.render_wav(export.id) end)
      send_resp(conn, 202, "")
    %Export{status: :completed} = e ->
      redirect(conn, to: ~p"/api/projects/#{project_id}/exports/#{e.id}")
    %Export{status: :pending} ->
      send_resp(conn, 202, "")
  end
end
```

### Atomic Merge Tracks (POST /projects/:id/actions/merge-tracks)

```elixir
def merge_tracks(conn, %{"id" => project_id, "track_ids" => ids, "new_name" => name}) do
  case Projects.merge_tracks(project_id, ids, name) do
    {:ok, new_track} -> conn |> put_status(201) |> json(%{track_id: new_track.id})
    {:error, reason} -> # handle
  end
end

# In context:
def merge_tracks(project_id, track_ids, new_name) do
  Repo.transaction(fn ->
    tracks = Repo.all(from t in Track, where: t.id in ^track_ids)
    # DSP merge call, insert new track, delete old tracks
  end)
end
```

---

## 7. Ecto Schemas (Planned)

### Project

```elixir
schema "projects" do
  field :name, :string
  field :bpm, :integer, default: 120
  field :time_signature, :string, default: "4/4"
  field :lock_version, :integer, default: 1   # for optimistic locking
  has_many :tracks, Backend.Track
  has_many :exports, Backend.Export
  timestamps(type: :utc_datetime)
end
```

### Track

```elixir
schema "tracks" do
  field :name, :string
  field :s3_key, :string
  field :position_ms, :integer, default: 0
  belongs_to :project, Backend.Project
  timestamps(type: :utc_datetime)
end
```

### Sample

```elixir
schema "samples" do
  field :name, :string
  field :genre, :string
  field :s3_key, :string
  field :duration_ms, :integer
  timestamps(type: :utc_datetime)
end
```

### Export

```elixir
schema "exports" do
  field :token, :string        # idempotency token
  field :status, Ecto.Enum, values: [:pending, :completed, :failed]
  field :s3_key, :string
  belongs_to :project, Backend.Project
  timestamps(type: :utc_datetime)
end
```

---

## 8. MinIO / S3 Integration (ExAws)

Library: `ex_aws` + `ex_aws_s3`. HTTP adapter: `hackney`. XML parser: `sweet_xml`.

Dev config (already in `config/dev.exs`):

```elixir
config :ex_aws,
  access_key_id: "minioadmin",
  secret_access_key: "minioadmin",
  region: "local"

config :ex_aws, :s3,
  scheme: "http://",
  host: "localhost",
  port: 9000
```

### Upload pattern

```elixir
def upload_sample(file_path, bucket, key) do
  file_path
  |> ExAws.S3.Upload.stream_file()
  |> ExAws.S3.upload(bucket, key)
  |> ExAws.request!()
end
```

### Delete pattern

```elixir
ExAws.S3.delete_object(bucket, key) |> ExAws.request!()
```

### Presigned URL (for client-side download)

```elixir
ExAws.S3.presigned_url(:get, bucket, key, expires_in: 3600)
```

**Rule:** Controllers must **never** proxy binary file content through Phoenix. Always serve presigned URLs or use Content Negotiation to redirect to MinIO.

---

## 9. DSP NIF Bridge

Module: `Backend.DSP` (to be created). Wraps Rust NIFs defined in `native/backend_dsp`.

```elixir
defmodule Backend.DSP do
  use Rustler, otp_app: :backend, crate: "backend_dsp"

  # These are stubs — implemented in Rust
  def ping(), do: :erlang.nif_error(:nif_not_loaded)
  def mix_and_stream(_tracks, _settings), do: :erlang.nif_error(:nif_not_loaded)
  def render_wav(_export_id), do: :erlang.nif_error(:nif_not_loaded)
end
```

**Critical:** Long-running NIFs (render_wav) **must** be `DirtyCpu` in Rust. See `native/backend_dsp/AGENTS.md`.

---

## 10. Elixir Language Rules

- **Never** use `String.to_atom/1` on user-supplied data (atom table is not GC'd).
- **Never** use map access syntax (`struct[:field]`) on Ecto structs; use `struct.field` or `Ecto.Changeset.get_field/2`.
- **Never** list programmatically set fields (e.g. `project_id`) in `cast/2` calls.
- Predicate function names must end in `?`, not start with `is_`.
- For index-based list access use `Enum.at/2`, never `list[index]`.
- Bind results of `if/case/cond` to a variable in outer scope; do not rebind inside the block.
- **Never** define multiple modules in one file.
- Use `Task.async_stream/3` with `timeout: :infinity` for concurrent enumeration with backpressure.

---

## 11. Testing Rules

- **Always** use `start_supervised!/1` to start processes in tests.
- **Never** use `Process.sleep/1` to wait; use `Process.monitor/1` + `assert_receive {:DOWN, ...}`.
- To synchronize before next call: `_ = :sys.get_state(pid)`.
- Run a single test file: `mix test test/path/to_test.exs`.
- Run all failed tests: `mix test --failed`.

---

## 12. Mix Aliases

```bash
mix setup          # deps.get + ecto.create + ecto.migrate + seeds
mix ecto.setup     # ecto.create + ecto.migrate + seeds
mix ecto.reset     # ecto.drop + ecto.setup
mix precommit      # compile --warnings-as-errors + deps.unlock --unused + format + test
```

Always run `mix precommit` before finishing work. Fix all warnings — they are treated as errors.

---

## 13. Dependencies Reference

| Hex package       | Version    | Purpose                                      |
|-------------------|------------|----------------------------------------------|
| phoenix           | ~> 1.8.5   | Web framework                                |
| phoenix_ecto      | ~> 4.5     | Phoenix + Ecto integration                   |
| ecto_sql          | ~> 3.13    | SQL adapter layer for Ecto                   |
| postgrex          | >= 0.0.0   | PostgreSQL driver                            |
| bandit            | ~> 1.5     | HTTP/WebSocket server (replaces Cowboy)      |
| jason             | ~> 1.2     | JSON encoder/decoder                         |
| rustler           | ~> 0.37.3  | Rust NIF integration                         |
| ex_aws            | ~> 2.6     | AWS/S3 client (used for MinIO)               |
| ex_aws_s3         | ~> 2.0     | S3-specific ExAws operations                 |
| hackney           | ~> 1.9     | HTTP client used by ExAws                    |
| sweet_xml         | ~> 0.7     | XML parser used by ExAws S3 responses        |
| dns_cluster       | ~> 0.2.0   | BEAM cluster node discovery                  |
| telemetry_metrics | ~> 1.0     | Metrics definitions                          |
| telemetry_poller  | ~> 1.0     | Periodic telemetry events                    |
| gettext           | ~> 1.0     | Internationalization                         |

> **Do not add** `:httpoison`, `:tesla`, or `:httpc`. Use `Req` for any additional HTTP client needs.

---

## 14. Phoenix v1.8 Specifics

- This project is **JSON API only** — no LiveView, no HTML templates.
- `Phoenix.View` is removed; use controllers with `json/2` render.
- Router `scope` blocks provide module alias prefix — never duplicate it in route definitions.
- `BackendWeb` use macros: `:controller`, `:channel`, `:router` — defined in `lib/backend_web.ex`.
- Endpoint uses `Bandit.PhoenixAdapter` (not Cowboy adapter).

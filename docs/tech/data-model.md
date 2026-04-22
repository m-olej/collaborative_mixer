# Data Model

## Entity-Relationship Diagram

```
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│   projects   │       │    tracks    │       │   exports    │
├──────────────┤       ├──────────────┤       ├──────────────┤
│ id (PK)      │──┐    │ id (PK)      │       │ id (PK)      │
│ name         │  │    │ name         │       │ token (UNIQ) │
│ bpm          │  ├───►│ s3_key       │   ┌──►│ status       │
│ time_sig.    │  │    │ position_ms  │   │   │ s3_key       │
│ count_in_nv  │  │    │ project_id(FK)│──┘   │ project_id(FK)│
│ lock_version │  │    │ inserted_at  │       │ inserted_at  │
│ inserted_at  │  │    │ updated_at   │       │ updated_at   │
│ updated_at   │  │    └──────────────┘       └──────────────┘
└──────────────┘  │
                  │    ┌──────────────┐
                  │    │   samples    │
                  │    ├──────────────┤
                  │    │ id (PK)      │
                  │    │ name         │
                  │    │ genre        │
                  │    │ s3_key       │
                  │    │ duration_ms  │
                  │    │ input_history│
                  │    │ bar_count    │
                  │    │ inserted_at  │
                  │    │ updated_at   │
                  │    └──────────────┘
                  │    (no FK — samples are global)
```

---

## Table Definitions

### `projects`

| Column | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `id` | `bigserial` | auto | PK | Primary key |
| `name` | `varchar` | — | NOT NULL | Project name |
| `bpm` | `integer` | `120` | NOT NULL, 1–998 | Tempo in beats per minute |
| `time_signature` | `varchar` | `"4/4"` | NOT NULL | Time signature (e.g., "4/4", "3/4", "6/8") |
| `count_in_note_value` | `varchar` | `"quarter"` | — | Metronome count-in grid: "quarter", "eighth", or "sixteenth" |
| `lock_version` | `integer` | `1` | NOT NULL | Optimistic locking counter (used by Ecto) |
| `inserted_at` | `utc_datetime` | auto | — | Creation timestamp |
| `updated_at` | `utc_datetime` | auto | — | Last modification timestamp |

### `tracks`

| Column | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `id` | `bigserial` | auto | PK | Primary key |
| `name` | `varchar` | — | NOT NULL | Track name |
| `s3_key` | `varchar` | — | NOT NULL | MinIO object key for audio file |
| `position_ms` | `integer` | `0` | NOT NULL, ≥ 0 | Position on the timeline in milliseconds |
| `project_id` | `bigint` | — | NOT NULL, FK → projects (CASCADE) | Parent project |
| `inserted_at` | `utc_datetime` | auto | — | |
| `updated_at` | `utc_datetime` | auto | — | |

**Indexes**: `[:project_id]`

### `samples`

| Column | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `id` | `bigserial` | auto | PK | Primary key |
| `name` | `varchar` | — | NOT NULL | Sample name |
| `genre` | `varchar` | — | nullable | Genre tag |
| `s3_key` | `varchar` | — | NOT NULL | MinIO object key |
| `duration_ms` | `integer` | — | nullable | Total duration in milliseconds |
| `input_history` | `jsonb` | — | nullable | Array of recorded note events (see below) |
| `bar_count` | `integer` | `1` | NOT NULL, 1–16 | Number of bars in the recording |
| `inserted_at` | `utc_datetime` | auto | — | |
| `updated_at` | `utc_datetime` | auto | — | |

#### `input_history` JSON Structure

When present, `input_history` is a JSON array of note events:

```json
[
  {
    "midi": 60,
    "note": "C4",
    "frequency": 261.63,
    "start_ms": 0,
    "end_ms": 500
  },
  {
    "midi": 64,
    "note": "E4",
    "frequency": 329.63,
    "start_ms": 200,
    "end_ms": 800
  }
]
```

### `exports`

| Column | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `id` | `bigserial` | auto | PK | Primary key |
| `token` | `varchar` | — | NOT NULL, UNIQUE | Idempotency token (UUID) |
| `status` | `varchar` | `"pending"` | NOT NULL, ∈ {"pending","completed","failed"} | Export state |
| `s3_key` | `varchar` | — | nullable | MinIO object key for exported WAV |
| `project_id` | `bigint` | — | NOT NULL, FK → projects (CASCADE) | Parent project |
| `inserted_at` | `utc_datetime` | auto | — | |
| `updated_at` | `utc_datetime` | auto | — | |

**Indexes**: unique `[:token]`, `[:project_id]`

---

## Ecto Schemas

### `Backend.Projects.Project`

```elixir
schema "projects" do
  field(:name, :string)
  field(:bpm, :integer, default: 120)
  field(:time_signature, :string, default: "4/4")
  field(:count_in_note_value, :string, default: "quarter")
  field(:lock_version, :integer, default: 1)
  has_many(:tracks, Backend.Projects.Track)
  has_many(:exports, Backend.Exports.Export)
  timestamps(type: :utc_datetime)
end
```

**Changeset**: casts `[:name, :bpm, :time_signature, :count_in_note_value]`, validates required `[:name, :bpm]`, validates `bpm` in `1..998`, uses `optimistic_lock(:lock_version)`.

### `Backend.Projects.Track`

```elixir
schema "tracks" do
  field(:name, :string)
  field(:s3_key, :string)
  field(:position_ms, :integer, default: 0)
  belongs_to(:project, Backend.Projects.Project)
  timestamps(type: :utc_datetime)
end
```

**Changeset**: casts `[:name, :s3_key, :position_ms]`, validates required `[:name, :s3_key]`, validates `position_ms >= 0`.

### `Backend.Samples.Sample`

```elixir
schema "samples" do
  field(:name, :string)
  field(:genre, :string)
  field(:s3_key, :string)
  field(:duration_ms, :integer)
  field(:input_history, :map)
  field(:bar_count, :integer, default: 1)
  timestamps(type: :utc_datetime)
end
```

**Changeset**: casts `[:name, :genre, :s3_key, :duration_ms, :input_history, :bar_count]`, validates required `[:name, :s3_key]`, validates `bar_count` in `1..16`.

### `Backend.Exports.Export`

```elixir
schema "exports" do
  field(:token, :string)
  field(:status, :string, default: "pending")
  field(:s3_key, :string)
  belongs_to(:project, Backend.Projects.Project)
  timestamps(type: :utc_datetime)
end
```

**Changeset**: casts `[:token, :status, :s3_key]`, validates required `[:token]`, validates `status` ∈ `["pending", "completed", "failed"]`, unique constraint on `:token`.

---

## Context Modules

### `Backend.Projects`

| Function | Description |
|---|---|
| `list_projects/0` | Returns all projects |
| `get_project/1` | Returns `{:ok, project}` or `{:error, :not_found}` |
| `create_project/1` | Creates a project from attributes map |
| `update_project/2` | Updates a project; uses `optimistic_lock` |
| `delete_project/1` | Deletes a project |
| `etag/1` | Computes MD5 hash of `"id:updated_at"` |
| `verify_etag/2` | Returns `:ok` or `{:error, :etag_mismatch}` |
| `list_tracks/1` | Returns tracks for a project |
| `get_track!/1` | Returns a track or raises |
| `create_track/2` | Creates a track for a project |
| `merge_tracks/3` | Atomic: validates IDs, creates merged track, deletes originals — all in `Repo.transaction` |

### `Backend.Samples`

| Function | Description |
|---|---|
| `list_samples/1` | Paginated: accepts `%{"page" => n, "limit" => m}`, returns `%{data, page, limit, total}` |
| `get_sample/1` | Returns `{:ok, sample}` or `{:error, :not_found}` |
| `create_sample/1` | Creates a sample from attributes map |
| `delete_sample/1` | Deletes a sample |

### `Backend.Exports`

| Function | Description |
|---|---|
| `list_exports/1` | Returns all exports for a project |
| `get_export/1` | Returns `{:ok, export}` or `{:error, :not_found}` |
| `find_by_token/1` | Looks up an export by its idempotency token |
| `create_export/2` | Creates an export for a project |
| `mark_completed/2` | Sets status to "completed" and assigns s3_key |
| `mark_failed/1` | Sets status to "failed" |
| `delete_export/1` | Deletes an export |

---

## Migration History

| Timestamp | File | Changes |
|---|---|---|
| `20260417023952` | `create_projects.exs` | Creates `projects` table |
| `20260417023953` | `create_tracks.exs` | Creates `tracks` table with FK to projects |
| `20260417023954` | `create_samples.exs` | Creates `samples` table |
| `20260417023955` | `create_exports.exs` | Creates `exports` table with unique token index |
| `20260422120000` | `add_sample_input_history_and_project_count_in.exs` | Adds `samples.input_history` (map) and `projects.count_in_note_value` (string) |
| `20260422130000` | `add_bar_count_to_samples.exs` | Adds `samples.bar_count` (integer, default 1) |

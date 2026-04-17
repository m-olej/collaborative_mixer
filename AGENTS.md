# Cloud DAW — Project Agent Guide (Root)

> This file provides the authoritative project-wide knowledge base for AI agents working on the Cloud DAW codebase. Read this first, then read the AGENTS.md in the specific subdirectory you are working in.

---

## 1. Project Purpose

**Cloud DAW** is a browser-based multi-user Digital Audio Workstation. Multiple users can collaborate asynchronously in real time on the same mixing session. The system is an academic project demonstrating:

- **Project 1 (WebSocket):** Real-time multi-user state sync, binary audio streaming, server-authoritative architecture.
- **Project 2 (REST API):** Full CRUD resources, paginated collections, optimistic locking (ETag/If-Match), idempotent POST with tokens, atomic controller resources.

---

## 2. Repository Layout

```
cloud_daw/
├── AGENTS.md                  ← YOU ARE HERE
├── README.md                  ← Human-readable project description
├── docker-compose.yml         ← Infrastructure: PostgreSQL + MinIO
├── docs/
│   ├── api.md                 ← Binary frame format + REST endpoint contracts
│   ├── assumptions.md         ← Hard constraints (NEVER break these)
│   └── technologies.md        ← Technology stack + coding rules
├── backend/                   ← Elixir/Phoenix application
│   ├── AGENTS.md              ← Backend-specific agent guide
│   ├── lib/
│   │   ├── backend/           ← Domain/context layer (Ecto, business logic)
│   │   └── backend_web/       ← HTTP layer (controllers, channels, router)
│   ├── native/backend_dsp/    ← Rust NIF library (DSP engine)
│   │   └── AGENTS.md         ← Rust/DSP-specific agent guide
│   └── priv/repo/migrations/  ← Ecto migrations
└── frontend/                  ← React + TypeScript SPA
    ├── AGENTS.md              ← Frontend-specific agent guide
    └── src/                   ← Application source
```

---

## 3. Architecture Overview

The system has three runtime layers that communicate in a strict hierarchy:

```
Browser (React + Web Audio API + Canvas)
        ↕  WebSocket (binary PCM/FFT) + REST JSON
Elixir/Phoenix  (GenServer sessions + REST controllers)
        ↕  Rustler NIF call (in-process, no HTTP)
Rust DSP Engine  (symphonia, biquad, rustfft, hound, rubato)
```

### Data stores

| Store      | Technology       | Purpose                                              |
|------------|------------------|------------------------------------------------------|
| PostgreSQL | Ecto + Postgrex  | Persistent: projects, tracks, samples metadata, exports |
| MinIO      | ExAws + S3 API   | Object storage for audio files and exported WAVs     |
| RAM (BEAM) | Elixir GenServer | Volatile: live mixer state (faders, EQ, playhead)    |

### Infrastructure (docker-compose)

```
postgres  → port 5432  (user: postgres / password: postgres / db: cloud_daw_dev)
minio     → port 9000  (S3 API) + 9001 (Web UI)
           credentials: minioadmin / minioadmin
backend   → port 4000  (Phoenix, HTTP only in dev)
```

---

## 4. Communication Protocols — Strict Separation

> **CRITICAL:** This boundary must never be violated.

| Layer       | Protocol  | Carries                                                      |
|-------------|-----------|--------------------------------------------------------------|
| WebSocket   | Binary    | PCM Float32 audio frames, FFT Uint8 spectrum, slider state  |
| WebSocket   | JSON text | Channel control messages (join, init_state, slider_update)  |
| REST API    | JSON      | Persistent metadata: projects, tracks, samples, exports     |
| REST API    | multipart | File upload for audio samples                               |
| REST API    | binary    | Streaming download of exported WAV files                    |

REST is **never** used for real-time mixing. WebSocket is **never** used for persistent storage.

---

## 5. Binary WebSocket Frame Format

All audio frames flowing from server to client use this exact binary layout (Little Endian):

| Offset     | Size     | JS Type         | Rust Type  | Content                              |
|------------|----------|-----------------|------------|--------------------------------------|
| 0          | 1 byte   | `Uint8`         | `u8`       | Message type ID (`1` = audio frame)  |
| 1–3        | 3 bytes  | padding         | `[u8; 3]`  | Zero-padding for 4-byte alignment    |
| 4–515      | 512 bytes| `Uint8Array(512)`| `[u8; 512]`| FFT spectrum (0–255 per bin)        |
| 516+       | N×4 bytes| `Float32Array(N)`| `Vec<f32>` | PCM samples (−1.0 to 1.0)          |

**JS decoding:**
```ts
const fft  = new Uint8Array(buffer, 4, 512);
const pcm  = new Float32Array(buffer, 516);
```

---

## 6. REST API Endpoints (Base prefix: `/api`)

| Method | URI                                        | Notes                                              |
|--------|--------------------------------------------|----------------------------------------------------|
| GET    | `/projects`                                | List all projects                                  |
| POST   | `/projects`                                | Create project `{name, bpm}`                       |
| GET    | `/projects/:id`                            | Get project; response includes `ETag` header       |
| PUT    | `/projects/:id`                            | Update; requires `If-Match: "etag"` header         |
| DELETE | `/projects/:id`                            | Delete project                                     |
| GET    | `/samples?page=1&limit=50`                 | Paginated sample library                           |
| POST   | `/samples`                                 | Upload sample (multipart/form-data)                |
| DELETE | `/samples/:id`                             | Delete sample from DB + MinIO                      |
| POST   | `/projects/:id/exports?token=UUID`         | Start WAV render (idempotent via token) → 202      |
| GET    | `/projects/:id/exports/:eid`               | Download WAV or get metadata (Content Negotiation) |
| POST   | `/projects/:id/actions/merge-tracks`       | Atomic merge `{track_ids, new_name}` → 201         |

### HTTP Status codes (academic requirements)

- `412 Precondition Failed` — `If-Match` value does not match current ETag
- `428 Precondition Required` — `If-Match` header missing on PUT
- `202 Accepted` — Export job accepted or already running (same token)
- `303 See Other` — Export previously completed, redirect to result
- `405 Method Not Allowed` — HTTP method not supported on that resource

---

## 7. Hard Constraints — Never Break

These are graded academic requirements. Violating them causes project failure.

1. **Binary WebSocket** — Audio/FFT must use binary frames, not JSON.
2. **Canvas rendering** — FFT must be drawn on `<canvas>` via `requestAnimationFrame`.
3. **Server-Authoritative** — Full mixer state lives in a `GenServer`. Clients request initial state snapshot on join.
4. **Multi-room scalability** — Each project session is an isolated `GenServer` process.
5. **Pagination** — `GET /api/samples` must accept `?page=N&limit=N`.
6. **Optimistic locking** — `PUT /api/projects/:id` enforces `If-Match` / ETag.
7. **Idempotent export** — `POST /api/projects/:id/exports?token=UUID` must be safe to replay.
8. **Atomic merge** — `POST /api/projects/:id/actions/merge-tracks` must run inside a single `Repo.transaction`.
9. **Dirty NIFs** — All long-running Rust functions MUST use `schedule = "DirtyCpu"` to avoid BEAM scheduler starvation.
10. **No JSON for real-time** — PCM and FFT data never pass through a JSON encoder.

---

## 8. Development Commands

```bash
# Start infrastructure
docker compose up -d

# Backend (from /backend)
mix deps.get
mix ecto.setup          # creates DB, runs migrations, seeds
mix phx.server          # starts on http://localhost:4000

# Run before any commit
mix precommit           # compile --warnings-as-errors + format + test

# Frontend (from /frontend)
npm install
npm run dev             # starts Vite dev server
npm run build           # TypeScript check + Vite production build
npm run lint            # ESLint
```

---

## 9. Cross-Cutting Concerns

### Error handling
- Elixir: use `with` chains for multi-step operations; return tagged tuples `{:ok, result}` / `{:error, reason}`.
- Rust NIFs: return `NifResult<T>`, never panic inside a NIF (causes BEAM crash).
- Frontend: all WebSocket reconnect logic should be handled at the Zustand store level.

### Security
- User input must never be passed to `String.to_atom/1` (atom table leak).
- Fields set programmatically (e.g. `user_id`) must NOT be in Ecto `cast/2` calls.
- MinIO credentials in dev are hardcoded; in production they come from environment variables.

### Audio format
- Internal DSP format: `f32` PCM, sample rate normalized by `rubato`.
- Wire format: raw Little-Endian `Float32` (no compression, no Opus, no MP3 encoding in-flight).

---

## 10. Subdirectory AGENTS.md Files

Read the AGENTS.md in the directory you are working in:

- [backend/AGENTS.md](backend/AGENTS.md) — Elixir, Phoenix, Ecto, GenServer, Channels, ExAws
- [backend/native/backend_dsp/AGENTS.md](backend/native/backend_dsp/AGENTS.md) — Rust NIF, DSP pipeline, crate API
- [frontend/AGENTS.md](frontend/AGENTS.md) — React, TypeScript, Zustand, Web Audio API, Canvas

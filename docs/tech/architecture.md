# System Architecture

## Overview

Cloud DAW is a three-layer system where the browser, Elixir application server, and Rust DSP engine communicate in a strict hierarchy:

```
┌─────────────────────────────────────────────────────┐
│  Browser (React + Web Audio API + Canvas)            │
│  - SPA rendered in the browser                       │
│  - AudioWorklet for PCM playback                     │
│  - Canvas for FFT/oscilloscope/piano roll rendering  │
└──────────────────────┬──────────────────────────────┘
                       │
          WebSocket (binary PCM/FFT + JSON control)
          REST/JSON (CRUD, file upload, exports)
                       │
┌──────────────────────▼──────────────────────────────┐
│  Elixir / Phoenix  (port 4000)                       │
│  - Phoenix Channels for real-time events             │
│  - REST controllers for persistent resources         │
│  - GenServer per project session (RAM state)         │
│  - DynamicSupervisor for session lifecycle           │
└──────────────────────┬──────────────────────────────┘
                       │
              Rustler NIF call (in-process, no HTTP)
                       │
┌──────────────────────▼──────────────────────────────┐
│  Rust DSP Engine  (compiled as native .so)           │
│  - fundsp oscillators + filters + effects            │
│  - rustfft for spectrum analysis                     │
│  - Runs on BEAM DirtyCpu schedulers                  │
└─────────────────────────────────────────────────────┘
```

## Data Stores

| Store | Technology | Purpose |
|---|---|---|
| PostgreSQL | Ecto + Postgrex | Persistent: projects, tracks, samples metadata, exports |
| MinIO | ExAws S3 API | Object storage for audio files and exported WAVs |
| RAM (BEAM) | Elixir GenServer | Volatile: live mixer state (faders, EQ, playhead), synth parameters |

## Infrastructure (docker-compose)

The development environment runs three containers:

```
postgres  → port 5432   (user: postgres / password: postgres / db: cloud_daw_dev)
minio     → port 9000   (S3 API) + port 9001 (Web UI console)
             credentials: minioadmin / minioadmin
backend   → port 4000   (Phoenix HTTP + WebSocket, dev mode)
```

Persistent Docker volumes:
- `cloud_daw_db_data` — PostgreSQL data directory
- `cloud_daw_object_data` — MinIO object storage

## OTP Supervision Tree

The backend application starts the following supervision tree:

```
Backend.Application (one_for_one)
├── BackendWeb.Telemetry          # Telemetry metrics reporter
├── Backend.Repo                  # Ecto repository (PostgreSQL connection pool)
├── DNSCluster                    # Distributed node discovery (noop in dev)
├── {Phoenix.PubSub, name: Backend.PubSub}
├── {Registry, name: Backend.SessionRegistry, keys: :unique}
├── Backend.DawSession.SessionSupervisor   # DynamicSupervisor
└── BackendWeb.Endpoint           # Bandit HTTP server
```

### Session Process Lifecycle

Each project that has active WebSocket clients gets its own `SessionServer` GenServer:

```
SessionSupervisor (DynamicSupervisor, :one_for_one)
├── SessionServer (project_id: 1)   ← registered via Registry
├── SessionServer (project_id: 5)
└── SessionServer (project_id: 12)
```

Sessions are started on-demand when the first client joins a project channel (`ensure_started/1` is idempotent). Each session holds:

- Mixer state: track volumes, mutes, 3-band EQ, master volume, transport
- Synthesizer parameters: oscillator, filter, LFO, effects, volume (21 fields)
- Last bar render cache: for `save_sample` without re-rendering

## Communication Protocol Separation

| Layer | Protocol | Carries |
|---|---|---|
| WebSocket | Binary frames | PCM Float32 audio, FFT Uint8 spectrum |
| WebSocket | JSON text | Channel control (join, init_state, slider_update) |
| REST API | JSON | Persistent metadata: projects, tracks, samples, exports |
| REST API | multipart | File upload for audio samples |
| REST API | binary | Streaming download of exported WAV files |

**Hard boundary**: REST is never used for real-time mixing. WebSocket is never used for persistent storage.

## Request Flow Examples

### Synth Patch Update (WebSocket)

```
Browser                    Phoenix Channel         SessionServer          Rust NIF
   │                            │                       │                    │
   │── patch_update (JSON) ────►│                       │                    │
   │                            │── call {:patch_and_   │                    │
   │                            │   render, params} ───►│                    │
   │                            │                       │── render_synth ───►│
   │                            │                       │   (DirtyCpu)       │
   │                            │                       │◄── binary frame ───│
   │                            │◄── {:ok, binary} ─────│                    │
   │◄── audio_buffer (binary) ──│                       │                    │
```

### Note Preview (WebSocket, non-blocking)

```
Browser              Channel Process          SessionServer           Task
   │                      │                        │                    │
   │── note_preview ─────►│                        │                    │
   │                      │── cast {:render_       │                    │
   │                      │   note_preview} ──────►│                    │
   │                      │                        │── Task.start ─────►│
   │                      │                        │   (returns immed.) │
   │                      │                        │                    │── render_synth (DirtyCpu)
   │                      │◄─── {:note_audio, midi, binary} ───────────│
   │◄── note_audio ───────│                        │                    │
```

### Project Update (REST, optimistic locking)

```
Browser                   ProjectController       Projects Context
   │                           │                        │
   │── GET /projects/5 ──────►│                        │
   │◄── {project, ETag: "x"} ─│                        │
   │                           │                        │
   │── PUT /projects/5 ──────►│                        │
   │   If-Match: "x"          │── verify_etag ────────►│
   │   {name: "new"}          │◄── :ok ────────────────│
   │                           │── update_project ─────►│
   │◄── 200 {project} ────────│◄── {:ok, project} ─────│
```

## Network Topology

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│  Browser  │────►│  Vite    │────►│  Phoenix  │
│  :5173    │     │  proxy   │     │  :4000    │
│  (React)  │     │  /api →  │     │  HTTP+WS  │
│           │     │  /socket │     │           │
└──────────┘     └──────────┘     └─────┬─────┘
                                        │
                              ┌─────────┼─────────┐
                              │         │         │
                        ┌─────▼──┐ ┌────▼───┐ ┌──▼──────┐
                        │Postgres│ │ MinIO  │ │Rust NIF │
                        │ :5432  │ │ :9000  │ │(in-proc)│
                        └────────┘ └────────┘ └─────────┘
```

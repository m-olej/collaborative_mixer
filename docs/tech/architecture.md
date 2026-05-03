# System Architecture

## Overview

Cloud DAW is a three-layer system where the browser, Elixir application server, and Rust DSP engine communicate in a strict hierarchy:

```
┌─────────────────────────────────────────────────────┐
│  Browser (React + Web Audio API + Canvas)            │
│  - SPA rendered in the browser                       │
│  - AudioWorklet for PCM playback (ring buffer)       │
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
│  - GenServer per user session (playback pacing)      │
│  - GenServer per active voice (streaming audio)      │
│  - DynamicSupervisors for session lifecycle          │
└──────────────────────┬──────────────────────────────┘
                       │
              Rustler NIF call (in-process, no HTTP)
                       │
┌──────────────────────▼──────────────────────────────┐
│  Rust DSP Engine  (compiled as native .so)           │
│  - fundsp oscillators + filters + effects            │
│  - ADSR envelopes (amp + filter modulation)          │
│  - rustfft for spectrum analysis                     │
│  - ResourceArc-backed stateful voices + timeline     │
│  - Runs on BEAM DirtyCpu schedulers                  │
└─────────────────────────────────────────────────────┘
```

## Data Stores

| Store | Technology | Purpose |
|---|---|---|
| PostgreSQL | Ecto + Postgrex | Persistent: projects, tracks, samples metadata, exports |
| MinIO | ExAws S3 API | Object storage for audio files and exported WAVs |
| RAM (BEAM) | Elixir GenServer | Volatile: live mixer state (faders, EQ, playhead), synth parameters per design view |

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

```
Backend.Supervisor (one_for_one)
├── BackendWeb.Telemetry              # Telemetry metrics reporter
├── Backend.Repo                      # Ecto repository (PostgreSQL connection pool)
├── DNSCluster                        # Distributed node discovery (noop in dev)
├── {Phoenix.PubSub, name: Backend.PubSub}
├── BackendWeb.Presence               # Phoenix.Presence tracker
├── {Registry, name: Backend.SessionRegistry, keys: :unique}
├── Backend.DawSession.SessionSupervisor       # DynamicSupervisor for ProjectSession
├── Backend.DawSession.UserSessionSupervisor   # DynamicSupervisor for UserSession
└── BackendWeb.Endpoint               # Bandit HTTP server
```

### Session Process Lifecycle

Each project with active WebSocket clients gets its own `ProjectSession` GenServer. Each user gets a `UserSession` for playback pacing. Each active note gets a `VoiceStreamer` for streaming audio.

```
SessionSupervisor (DynamicSupervisor)
├── ProjectSession (project_id: 1)       ← registered via Registry
├── ProjectSession (project_id: 5)
└── ProjectSession (project_id: 12)

UserSessionSupervisor (DynamicSupervisor)
├── UserSession ({:user, 1, "alice"})    ← per-user playback pacing
├── UserSession ({:user, 1, "bob"})
└── UserSession ({:user, 5, "charlie"})

VoiceStreamer processes (temporary, spawned per note)
├── VoiceStreamer (midi: 60, project: 1) ← spawned by channel on note_preview
├── VoiceStreamer (midi: 64, project: 1) ← dies when voice is done
└── VoiceStreamer (midi: 67, project: 1)
```

Sessions are started on-demand when the first client joins a project channel (`ensure_started/1` is idempotent). Each ProjectSession holds:

- Mixer state: track volumes, mutes, pans, 3-band EQ, master volume, transport
- Design views: per-view synth parameters (29 fields each including ADSR envelopes)
- Timeline engine: Rust ResourceArc for mmap-backed audio playback
- Last bar render cache: for `save_sample` without re-rendering

## Communication Protocol Separation

| Layer | Protocol | Carries |
|---|---|---|
| WebSocket | Binary frames | PCM Float32 audio, FFT Uint8 spectrum |
| WebSocket | JSON text | Channel control (join, init_state, slider_update, design_view_update) |
| REST API | JSON | Persistent metadata: projects, tracks, samples, exports |
| REST API | multipart | File upload for audio samples |
| REST API | binary | Streaming download of exported WAV files |

**Hard boundary**: REST is never used for real-time mixing. WebSocket is never used for persistent storage.

## Audio Pipelines

The system has three independent audio pipelines:

### 1. Synth Render (stateless, one-shot)

Used by "Render Sound" button and polyphonic bar rendering. All DSP nodes are constructed fresh per call — pure function.

```
Browser                    Phoenix Channel         ProjectSession          Rust NIF
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

### 2. Streaming Voice (stateful, burst & pace)

Used by keyboard note preview. Each note spawns a `VoiceStreamer` GenServer that owns a persistent Rust `SynthVoiceResource`. The voice retains oscillator phase, envelope position, filter state, and effects buffers across chunk renders.

```
Browser              Channel Process          VoiceStreamer           Rust NIF
   │                      │                        │                    │
   │── note_preview ─────►│                        │                    │
   │                      │── start_link ─────────►│                    │
   │                      │   (channel_pid, midi,  │── create_synth    │
   │                      │    synth_params, freq)  │   _voice ────────►│
   │                      │                        │◄── ResourceArc ───│
   │                      │                        │                    │
   │                      │                        │── render_voice     │
   │                      │                        │   _chunk(8820) ───►│
   │                      │◄── {:voice_audio, ─────│◄── binary frame ──│  ← 200ms burst
   │◄── voice_audio ──────│     midi, binary}      │                    │
   │                      │                        │                    │
   │                      │              ┌─────── :tick (50ms) ─────────┤
   │                      │              │         │── render_voice     │
   │                      │              │         │   _chunk(2205) ───►│
   │                      │◄── {:voice_audio} ─────│◄── binary frame ──│  ← 50ms pace
   │◄── voice_audio ──────│              │         │                    │
   │                      │              └─────────┤                    │
   │                      │                        │                    │
   │── key_up ───────────►│── note_off ───────────►│── voice_note_off ─►│  ← trigger release
   │                      │                        │                    │
   │                      │              ┌── :tick continues until ─────┤
   │                      │              │  voice_is_done() == true     │
   │                      │              │         │                    │
   │◄── voice_done ───────│◄── {:voice_done} ─────│ (process exits)    │
```

### 3. Timeline Playback (stateful, burst & pace)

Used by mixer timeline. `UserSession` drives pacing; `ProjectSession` delegates to Rust engine.

```
Browser              Channel          UserSession          ProjectSession     Rust NIF
   │                    │                  │                     │               │
   │── start_playback ─►│                  │                     │               │
   │                    │── start ────────►│                     │               │
   │                    │                  │── mix_chunk(200ms) ─►│               │
   │                    │                  │                     │── mix_chunk ──►│
   │                    │                  │                     │◄── binary ────│
   │                    │                  │◄── {:ok, binary} ───│               │
   │◄── audio_frame ────│◄── send ────────│                     │               │
   │                    │                  │                     │               │
   │                    │   ┌── :push_chunk (50ms interval) ────┤               │
   │                    │   │              │── mix_chunk(50ms) ──►│              │
   │◄── audio_frame ────│◄──│── send ─────│                     │               │
   │                    │   └──────────────┤                     │               │
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

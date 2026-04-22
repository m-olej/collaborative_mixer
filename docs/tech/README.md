# Cloud DAW — Technical Documentation

This directory contains the complete technical documentation for the Cloud DAW project — a browser-based multi-user Digital Audio Workstation.

## Document Index

| Document | Description |
|---|---|
| [architecture.md](architecture.md) | System architecture, runtime topology, supervision tree, deployment |
| [design-choices.md](design-choices.md) | Key engineering decisions and their rationale |
| [rest-api.md](rest-api.md) | REST API endpoint reference (routes, payloads, status codes) |
| [websocket-protocol.md](websocket-protocol.md) | WebSocket channel events, binary wire frame format |
| [data-model.md](data-model.md) | Database schema, Ecto models, migration history |
| [dsp-engine.md](dsp-engine.md) | Rust DSP engine: signal chain, NIFs, crate architecture |
| [frontend.md](frontend.md) | React/TypeScript SPA: components, state management, audio pipeline |
| [functionalities.md](functionalities.md) | User-facing features and workflows |

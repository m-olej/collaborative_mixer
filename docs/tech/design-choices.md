# Design Choices

This document explains the key engineering decisions made in the Cloud DAW project and their rationale.

---

## 1. Server-Authoritative Architecture

**Decision**: All DSP processing runs on the server (Elixir + Rust NIF). The browser is a thin client that sends control events and plays back rendered audio.

**Rationale**:
- **Consistency**: Multiple users collaborating on the same session see identical state. Server-authoritative design eliminates client-side drift.
- **Determinism**: The Rust DSP engine produces bit-identical output regardless of client hardware, browser, or OS audio stack.
- **Security**: Clients cannot manipulate the audio pipeline or inject malformed state.
- **Academic requirement**: The project specification requires server-authoritative GenServer state.

**Trade-off**: Latency — every note preview requires a round-trip to the server (typically 10–50 ms on localhost). This is acceptable for a mixing/design tool but would not work for a real-time performance instrument.

---

## 2. Binary WebSocket Frames (Not JSON)

**Decision**: Audio data (PCM + FFT) is transmitted as raw binary WebSocket frames, never JSON-encoded.

**Rationale**:
- **Bandwidth**: A 1-second stereo render is ~176 KB as raw Float32. JSON-encoding floats would inflate this 3–5×.
- **Zero-copy decoding**: The browser decodes binary frames using `TypedArray` views (`new Float32Array(buffer, offset)`) — no parsing, no allocation.
- **Latency**: JSON parsing of 44,100 float values per second would dominate CPU time.
- **Academic requirement**: Binary WebSocket frames are a graded constraint.

**Separation**: JSON is still used for control messages (slider updates, channel joins) where the payload is small and structured.

---

## 3. Rust NIF for DSP (Not Elixir/Erlang)

**Decision**: All audio synthesis and signal processing is implemented in Rust, compiled as a BEAM NIF via Rustler.

**Rationale**:
- **Performance**: Audio DSP requires tight floating-point loops at 44,100 iterations/second. BEAM's garbage-collected, dynamically-typed runtime cannot achieve the throughput needed.
- **Ecosystem**: The Rust audio ecosystem (fundsp, rustfft, symphonia, hound) provides production-grade oscillators, filters, and FFT implementations.
- **Safety**: Rust's ownership model prevents data races and memory corruption. NIFs that panic crash the BEAM — Rust's `Result` types make this avoidable.

**DirtyCpu scheduling**: All long-running NIFs use `#[rustler::nif(schedule = "DirtyCpu")]` to run on dedicated OS threads, avoiding BEAM scheduler starvation. A 1-second render at 44.1 kHz takes ~5 ms — short enough to never block, but using DirtyCpu is a safety guarantee.

---

## 4. GenServer Per Project Session

**Decision**: Each active project gets its own `SessionServer` GenServer process, managed by a `DynamicSupervisor`.

**Rationale**:
- **Isolation**: A crash or slow render in one project cannot affect other sessions. The supervisor restarts the failed process.
- **Scalability**: BEAM can handle millions of lightweight processes. Adding sessions is O(1).
- **State locality**: All session state (mixer + synth parameters) is held in a single process's memory, eliminating distributed locking.
- **Concurrency**: Multiple clients in the same session send messages to the same GenServer, which serializes state mutations naturally.

**Registry**: Sessions are registered by project ID in a `Registry` with `:unique` keys, enabling O(1) lookup.

---

## 5. Optimistic Locking for Project Updates

**Decision**: `PUT /api/projects/:id` requires an `If-Match` header containing the project's ETag. Updates fail with `412 Precondition Failed` if the ETag doesn't match.

**Rationale**:
- **Multi-user safety**: Multiple users can edit project metadata concurrently. Without locking, the last write silently overwrites earlier changes.
- **No server-side sessions**: RESTful — the server doesn't track which clients have which versions. The ETag serves as a lightweight version identifier.
- **Academic requirement**: Optimistic locking with ETag/If-Match is a graded constraint.

**ETag implementation**: MD5 hash of `"#{project.id}:#{project.updated_at}"`, returned as a response header on GET.

---

## 6. Idempotent Export via Token

**Decision**: `POST /api/projects/:id/exports?token=UUID` uses the token for idempotency. Repeating the request with the same token returns the existing export rather than creating a duplicate.

**Rationale**:
- **Network safety**: Export rendering is expensive. If the client's network drops during the request, it can safely retry without triggering a duplicate render.
- **RESTful design**: POST is not inherently idempotent; the token parameter makes it so.
- **State machine**: The export progresses through `pending → completed/failed`. A `303 See Other` redirect for completed exports tells the client where to download the result.

---

## 7. Polyphonic Rendering via Concurrent Tasks

**Decision**: Multi-note bar renders spawn one Elixir `Task.async` per note. Each task calls the Rust `render_voice_pcm` NIF independently. After all tasks complete, the Rust `mix_voices` NIF combines the results.

**Rationale**:
- **True parallelism**: Each NIF call runs on its own DirtyCpu thread. On a 4-core machine, 4 notes render simultaneously.
- **Simplicity**: Elixir's `Task.async` + `Task.await_many` is 3 lines of code for fan-out/fan-in concurrency.
- **Isolation**: If one voice render fails, it doesn't corrupt the others.

**Note preview**: Uses `GenServer.cast` + `Task.start` instead of `call` + `Task.async`, so the GenServer is never blocked during keyboard preview. Multiple simultaneous key presses each spawn independent tasks.

---

## 8. AudioWorklet Ring Buffer (Not ScriptProcessorNode)

**Decision**: Client-side audio playback uses an `AudioWorkletProcessor` with a pre-allocated ring buffer.

**Rationale**:
- **Performance**: `AudioWorkletProcessor.process()` runs on a dedicated audio thread (~344 times/second). No garbage collection pauses, no main-thread jank.
- **ScriptProcessorNode is deprecated**: It runs on the main thread, causing clicks and pops under load.
- **Zero allocation**: The ring buffer is allocated once (441,000 samples = 10 seconds at 44.1 kHz). `process()` never allocates memory.

**Dual write modes**:
- `append` (default): Sequential playback — new chunks play after the current audio finishes.
- `mix`: Additive mixing at the current read position — overlapping notes are summed. Used for polyphonic keyboard preview.

---

## 9. AudioBufferSourceNode for Note Preview

**Decision**: Keyboard note previews play via individual `AudioBufferSourceNode` instances (one per held key) rather than through the AudioWorklet ring buffer.

**Rationale**:
- **Per-note control**: Each source node has its own `GainNode`, allowing immediate fade-out on key release without affecting other notes.
- **Variable duration**: Notes play for as long as the key is held (up to 3 seconds of pre-rendered audio). A ring buffer approach cannot stop individual notes.
- **MIDI correlation**: The server embeds the MIDI note number in byte 1 of the wire frame. The client matches incoming audio to the correct key press.

**Fade-out**: On note release, `gain.setTargetAtTime(0, now, 0.015)` applies a smooth ~45 ms exponential fade to avoid clicks.

---

## 10. Canvas Rendering for Visualizations

**Decision**: FFT spectrum, oscilloscope, and piano roll are rendered on `<canvas>` elements using `requestAnimationFrame`.

**Rationale**:
- **Performance**: DOM-based rendering of 512 frequency bars at 60 fps would create massive layout thrashing. Canvas bypasses the DOM entirely.
- **Pixel control**: Audio visualizations require precise pixel placement that CSS cannot provide.
- **Academic requirement**: Canvas rendering via `requestAnimationFrame` is a graded constraint.

---

## 11. Zustand for State Management (Not Redux/Context)

**Decision**: Global state (socket connection, project list) is managed with Zustand stores.

**Rationale**:
- **Minimal API**: A Zustand store is a single function call — no providers, reducers, or action types.
- **Performance**: Zustand uses shallow equality by default, avoiding unnecessary re-renders. Components subscribe to specific state slices.
- **WebSocket integration**: The socket store manages connection lifecycle, channel joins, and incoming event handlers in one place.

---

## 12. No Client-Side DSP

**Decision**: The browser performs zero audio synthesis or signal processing. The only client-side audio code is:
- AudioWorklet ring buffer (playback only)
- Metronome click generation (static sine burst, not synthesizer processing)

**Rationale**:
- **Consistency**: See #1 (server-authoritative).
- **Simplicity**: One DSP implementation (Rust) instead of maintaining parallel JS + Rust codebases.
- **Browser limitations**: Web Audio API oscillators and filters differ across browsers. Server rendering guarantees identical output.

---

## 13. Atom Safety in Elixir

**Decision**: User-supplied strings are never converted to atoms via `String.to_atom/1`. All string → atom mappings use whitelisted conversion.

**Rationale**:
- **Atom table exhaustion**: The BEAM has a fixed atom table (default 1,048,576 entries). Converting arbitrary user input to atoms can exhaust it, crashing the entire VM.
- **Implementation**: `merge_synth_params/2` uses a hardcoded map of 21 known keys. `apply_slider_update/2` uses `when band in ["low", "mid", "high"]` guards before calling `String.to_existing_atom/1`.

---

## 14. Separation of Persistent and Volatile State

**Decision**: Project metadata (name, BPM, time signature) is persisted in PostgreSQL via REST. Mixer/synth state (faders, EQ, synth parameters) is volatile in GenServer RAM.

**Rationale**:
- **Speed**: Real-time mixer adjustments (60+ events/second per client) cannot be persisted on every change without severe latency.
- **Simplicity**: The client triggers an explicit save action when ready to persist. No conflict resolution needed for volatile state.
- **Appropriate durability**: Losing a fader position on server restart is acceptable. Losing a project name is not.

---

## 15. Multi-Bar Recording Architecture

**Decision**: Recording supports configurable bar counts (1–8). The total recording duration equals `barDurationMs × barCount`. Note timestamps are relative to the start of the first bar.

**Rationale**:
- **Musical flexibility**: Real musical phrases rarely fit in a single bar. Allowing 1–8 bars lets users record longer passages.
- **Unified timing**: All note events use absolute millisecond timestamps from recording start, regardless of which bar they fall in. This simplifies the render pipeline — the server treats the entire recording as one continuous duration.
- **Database design**: The `bar_count` column on `samples` stores the number of bars, allowing the frontend to draw bar boundary lines in the piano roll.

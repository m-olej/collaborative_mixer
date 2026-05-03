# Cloud DAW — Rust DSP Engine Agent Guide

> Rust NIF crate (`backend_dsp`). Read root `AGENTS.md` first for cross-cutting concerns.
> Compiled via `mix compile` (Rustler). Do **not** run `cargo` directly in CI — let Mix manage the build.

---

## 1. Crate Identity

| Key               | Value                                      |
|-------------------|--------------------------------------------|
| Crate name        | `backend_dsp`                              |
| Crate type        | `cdylib` (shared library loaded by BEAM)   |
| Rust edition      | 2021                                       |
| Rustler version   | 0.37.3                                     |
| Elixir NIF module | `Elixir.Backend.DSP`                       |
| Entry point       | `native/backend_dsp/src/lib.rs`            |
| Workspace root    | `backend/Cargo.toml`                       |

---

## 2. Dependencies

| Crate     | Version | Purpose                                                                |
|-----------|---------|------------------------------------------------------------------------|
| rustler   | 0.37.3  | Erlang NIF bindings                                                    |
| fundsp    | 0.23.0  | Band-limited oscillator nodes (`sine_hz`, `saw_hz`, etc.)             |
| biquad    | 0.6.0   | Biquad IIR filters for SVF/Moog low-pass (parametric EQ)              |
| rustfft   | 6.4.1   | FFT computation for spectrum visualizer                                |
| hound     | 3.5.1   | WAV file writing (for future export render)                            |
| rubato    | 2.0.0   | Sample-rate conversion (used by timeline decoder)                      |
| symphonia | 0.5.5 (`features=["all"]`) | Audio file decoding (WAV/MP3/FLAC for timeline tracks)    |
| tempfile  | 3.27.0  | Temporary files for mmap-backed decoded audio                          |
| memmap2   | 0.9     | Memory-mapped file access for zero-copy PCM reads                      |

> **Note:** `hound` is reserved for a future WAV export pipeline.

---

## 3. CRITICAL: BEAM Scheduler Safety (Dirty NIFs)

BEAM assumes NIFs complete in **< 1 millisecond**. Any NIF running longer blocks the scheduler and starves all other Erlang processes.

**All DSP functions that render audio MUST carry `schedule = "DirtyCpu"`.**

```rust
// ✅ CORRECT
#[rustler::nif(schedule = "DirtyCpu")]
fn render_synth<'a>(env: Env<'a>, state: SynthState, duration_secs: f64) -> NifResult<Binary<'a>> { ... }

// ❌ WRONG — blocks the scheduler
#[rustler::nif]
fn render_synth<'a>(...) -> NifResult<Binary<'a>> { ... }
```

### NIF Schedule Classification

| NIF                      | Schedule | Reason                                          |
|--------------------------|----------|-------------------------------------------------|
| `ping`                   | default  | Trivial, microseconds                           |
| `generate_tone`          | default  | Simple sine loop (testing only)                 |
| `render_synth`           | DirtyCpu | Full signal chain render (tens of ms)           |
| `render_voice_pcm`       | DirtyCpu | Single voice render (called concurrently)       |
| `mix_voices`             | DirtyCpu | Mixing + FFT + frame assembly                   |
| `generate_waveform_peaks`| DirtyCpu | PCM scan over potentially large buffers         |
| `create_synth_voice`     | default  | Creates ResourceArc<SynthVoice> (fast alloc)    |
| `render_voice_chunk`     | default  | Renders N samples from stateful voice (< 5 ms)  |
| `voice_note_off`         | default  | Triggers ADSR release (trivial state flip)       |
| `voice_is_done`          | default  | Checks envelope done + silence threshold         |
| `init_engine`            | default  | Creates empty ResourceArc<ProjectEngine>        |
| `decode_and_load_track`  | DirtyCpu | Decode audio + mmap + insert clip (100s of ms)  |
| `rebuild_timeline`       | default  | Replace interval tree atomically (< 1 ms)       |
| `set_track_params`       | default  | Update volume/mute/pan map (< 1 ms)             |
| `mix_chunk`              | DirtyCpu | Query tree, read mmap, mix, FFT, frame          |

---

## 4. Module Structure

```
src/
├── lib.rs          ← NIF registration, ResourceArc setup, on_load (2 resource types)
├── state.rs        ← SynthState struct (NifMap — 29 fields decoded from Elixir map)
├── engine.rs       ← Synth render orchestrator; wires all DSP nodes (stateless)
├── voice.rs        ← Streaming voice: persistent DSP state across render calls (stateful)
├── interface.rs    ← Binary wire-frame assembly (header + FFT + PCM)
├── mixer.rs        ← Polyphonic voice mixing + soft limiting + frame build
├── waveform.rs     ← Waveform peak generation for timeline thumbnails
├── timeline/       ← Timeline playback sub-module (NEW)
│   ├── mod.rs          ← ProjectEngine struct, ProjectEngineResource, TrackParams
│   ├── decoder.rs      ← symphonia decode → rubato resample → mono → tempfile
│   ├── mmap_store.rs   ← MmapStore: HashMap<track_id, MmapEntry> for zero-copy reads
│   ├── interval_tree.rs ← ClipInfo + ClipTree (sorted vec, O(log n + k) query)
│   └── chunk_mixer.rs  ← Hot path: query tree → read mmap → volume mix → FFT → frame
├── dsp/
    ├── mod.rs          ← Re-exports all DSP sub-modules
    ├── oscillators.rs  ← UnisonOscillator, build_unison_oscillator
    ├── filters.rs      ← FilterType (SVF / Moog / Highpass / Bandpass), build_filter
    ├── effects.rs      ← Drive, Distortion, Chorus, Reverb, Volume nodes
    ├── envelope.rs     ← ADSR envelope generator (amp + filter modulation)
    ├── lfo.rs          ← Lfo struct, LfoTarget enum
    └── fft.rs          ← compute_fft_spectrum, FFT_SIZE = 512
```

---

## 5. Exposed NIFs

```rust
rustler::init!("Elixir.Backend.DSP", [
    ping,
    generate_tone,
    render_synth,
    render_voice_pcm,
    mix_voices,
    generate_waveform_peaks,
    // Streaming voice NIFs
    create_synth_voice,
    render_voice_chunk,
    voice_note_off,
    voice_is_done,
    // Timeline playback NIFs
    init_engine,
    decode_and_load_track,
    rebuild_timeline,
    set_track_params,
    mix_chunk,
], load = on_load);
```

### `render_synth(state: SynthState, duration_secs: f64) -> Binary`

- Renders `duration_secs` seconds of audio (typically 1.0) from the synth parameter struct.
- Returns a complete binary **wire frame** with message type byte `2`.
- Calls `engine::render` → `interface::build_synth_frame`.
- The returned `Binary<'a>` is allocated on the Erlang heap via `OwnedBinary` — no double-copy.

### `render_voice_pcm(state: SynthState, duration_secs: f64) -> Binary`

- Renders a single voice as raw f32 LE PCM bytes (no header, no FFT).
- Used by `ProjectSession.render_bar/3` which spawns one `Task.async` per note and calls this NIF concurrently.

### `mix_voices(pcm_binaries: Vec<Binary>, offsets: Vec<i64>, total_samples: i64) -> Binary`

- Decodes each binary back to `Vec<f32>`.
- Additively mixes at their sample offsets into a single buffer of `total_samples`.
- Applies tanh soft limiting only where amplitude exceeds ±1.
- Computes FFT, assembles wire frame, returns binary (type 2).

### `generate_waveform_peaks(audio_binary: Binary, num_bins: i64) -> Vec<(f32, f32)>`

- Accepts a binary of f32 LE PCM samples.
- Returns `[{min, max}]` tuples for `num_bins` segments.
- Used by `ProjectChannel.handle_in("save_sample")` to generate timeline thumbnail data.

---

## 6. `SynthState` (state.rs)

Decoded automatically by Rustler from a plain Elixir map with **atom keys**.

```rust
#[derive(Debug, Clone, NifMap)]
pub struct SynthState {
    // Oscillator
    pub osc_shape: String,        // "saw" | "sine" | "square" | "triangle" | "noise"
    pub frequency: f32,           // Hz (e.g. 440.0)

    // Unison
    pub unison_voices: i32,       // 1–7
    pub unison_detune: f32,       // cents, 0–50
    pub unison_spread: f32,       // 0.0–1.0

    // Filter
    pub cutoff: f32,              // Hz (LPF cutoff)
    pub resonance: f32,           // 0.0–1.0 (Q)
    pub filter_type: String,      // "svf" | "moog" | "highpass" | "bandpass"

    // Drive / Distortion
    pub drive: f32,               // pre-filter overdrive multiplier (1.0 = clean)
    pub distortion_type: String,  // "off" | "soft_clip" | "hard_clip" | "atan"
    pub distortion_amount: f32,   // 0.0–1.0

    // LFO
    pub lfo_rate: f32,            // Hz, 0.1–20.0
    pub lfo_depth: f32,           // 0.0–1.0
    pub lfo_shape: String,        // "sine" | "triangle" | "square" | "saw"
    pub lfo_target: String,       // "cutoff" | "pitch" | "volume"

    // Chorus
    pub chorus_rate: f32,         // Hz, 0.1–5.0
    pub chorus_depth: f32,        // 0.0–1.0
    pub chorus_mix: f32,          // 0.0–1.0

    // Reverb
    pub reverb_decay: f32,        // 0.0–1.0
    pub reverb_mix: f32,          // 0.0–1.0

    // Amp
    pub volume: f32,              // 0.0–1.0

    // Amp ADSR Envelope
    pub amp_attack_ms: f32,       // 0–5000 ms
    pub amp_decay_ms: f32,        // 0–5000 ms
    pub amp_sustain: f32,         // 0.0–1.0
    pub amp_release_ms: f32,      // 0–5000 ms

    // Filter ADSR Envelope
    pub filter_attack_ms: f32,    // 0–5000 ms
    pub filter_decay_ms: f32,     // 0–5000 ms
    pub filter_sustain: f32,      // 0.0–1.0
    pub filter_release_ms: f32,   // 0–5000 ms
    pub filter_env_depth: f32,    // Hz (cutoff sweep amount)
}
```

`Default::default()` produces: saw @ 440 Hz, 1 voice, SVF @ 5 kHz, no effects, volume 0.8.

**Every field name must match the atom key in the Elixir `synth_params` map exactly** — Rustler validates at decode time.

---

## 7. Signal Chain (`engine.rs`)

```
SAMPLE_RATE = 44_100 Hz

Unison Oscillators (N detuned voices, fundsp band-limited)
        ↓
Filter (SVF / Moog / Highpass / Bandpass)
  modulated by LFO (block-rate) + Filter ADSR envelope
        ↓
Drive (tanh saturation via fundsp node)
        ↓
Distortion (soft_clip / hard_clip / atan, applied per sample)
        ↓
Amp ADSR Envelope (gates amplitude, prevents clicks)
        ↓
Chorus (modulated delay line, custom struct)
        ↓
Reverb (feedback delay network, custom struct)
        ↓
Volume (linear gain, optional LFO volume modulation)
        ↓
FFT (rustfft on final PCM → 512 Uint8 bins)
        ↓
Wire frame (interface::build_synth_frame)
```

`engine::render` is a pure function — same `SynthState` always produces the same audio.

`engine::render_pcm_only` skips FFT (used by `render_voice_pcm` for polyphonic voices).

---

## 8. Binary Wire Frame Layout (`interface.rs`)

```
Offset   Size          Content
───────────────────────────────────────────────────────────────
0        1 byte        Message type ID (1=mixer, 2=synth)
1        1 byte        MIDI note (voice_audio only, else 0)
2–3      2 bytes       Zero-padding (4-byte alignment)
4–515    512 bytes     FFT magnitude spectrum (0–255 per bin)
516+     N × 4 bytes   PCM samples (f32 LE, −1.0 to 1.0)
───────────────────────────────────────────────────────────────
```

Message type `1` is used for timeline/mixer audio frames (from `mix_chunk`). Type `2` is used for all synth, bar, and voice streaming renders.

### ResourceArc Types

Two ResourceArc types registered in `on_load`:

| Type | Wrapper | Purpose |
|---|---|---|
| `ProjectEngine` | `ProjectEngineResource(Mutex<ProjectEngine>)` | Timeline: mmap store, interval tree, track params |
| `SynthVoice` | `SynthVoiceResource(Mutex<SynthVoice>)` | Streaming voice: oscillators, envelopes, filters, effects |

**JS decoder:**
```js
const fft = new Uint8Array(buffer, 4, 512);
const pcm = new Float32Array(buffer, 516);
```

`build_synth_frame(fft: &FftBytes, pcm: &[f32]) -> Vec<u8>` pre-allocates the exact capacity to avoid reallocation. A `debug_assert!` validates the final length matches.

---

## 9. Unison Oscillator (`dsp/oscillators.rs`)

- Up to 7 voices stacked using `fundsp` band-limited primitives: `sine_hz`, `square_hz`, `triangle_hz`, `saw_hz`, `noise`.
- Voice frequencies spread symmetrically: `f × 2^(detune/1200)`.
- Phase randomization uses a deterministic LCG seed so renders are reproducible for a given `SynthState`.
- Gain normalized across voices to prevent clipping.
- With `spread > 0`, outer voices receive `1 - center_distance * spread * 0.3` amplitude weight.

---

## 10. Polyphonic Voice Mixing (`mixer.rs`)

```rust
pub fn mix_and_build_frame(
    voice_pcms: &[&[f32]],
    offsets: &[usize],
    total_samples: usize,
) -> Vec<u8>
```

1. Zero-initializes a `total_samples` buffer.
2. Additively sums each voice at its sample offset.
3. Applies `tanh` soft limiting only on samples where `|x| > 1.0` (preserves dynamics).
4. Computes FFT and calls `build_synth_frame`.

---

## 11. Memory Safety at the NIF Boundary

`render_synth` and all returning-binary NIFs follow this pattern:

```rust
let frame_bytes: Vec<u8> = build_synth_frame(&fft, &pcm);  // OS heap

let mut owned = OwnedBinary::new(frame_bytes.len())         // Erlang heap
    .ok_or(rustler::Error::BadArg)?;

owned.as_mut_slice().copy_from_slice(&frame_bytes);         // single copy

Ok(owned.release(env))                                      // BEAM takes ownership
```

- **One allocation** on the OS heap (the `Vec<u8>`).
- **One allocation** on the Erlang heap (`OwnedBinary`).
- **One copy** (OS → Erlang).
- After `release`, BEAM GC manages the binary — no double-free risk.
- Never `panic!` inside a NIF — use `NifResult` / `ok_or` everywhere.

---

## 12. Adding a New NIF — Checklist

1. Implement the function in the appropriate module (`engine.rs`, `mixer.rs`, etc.).
2. Add a NIF wrapper in `lib.rs` with the correct `schedule` annotation.
3. Register it in `rustler::init!`.
4. Add a stub + `@doc` in `lib/backend/dsp.ex`.
5. Run `mix compile` to rebuild the `.so`.
6. Run `mix precommit` to confirm no warnings or test failures.

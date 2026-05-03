# DSP Engine

The Rust DSP engine is compiled as a BEAM NIF (Native Implemented Function) via the Rustler framework. It handles all audio synthesis, signal processing, spectral analysis, voice mixing, and streaming voice playback.

**Location**: `backend/native/backend_dsp/`

## Crate Dependencies

| Crate | Version | Purpose |
|---|---|---|
| `rustler` | 0.37.3 | BEAM NIF interface — automatic Elixir ↔ Rust type conversion |
| `fundsp` | 0.23.0 | Audio DSP library — oscillators, filters, signal chain |
| `rustfft` | 6.4.1 | FFT computation for spectrum analysis |
| `symphonia` | 0.5.5 | Audio file decoding (all codecs/formats enabled) |
| `biquad` | 0.6.0 | Biquad filter coefficient computation |
| `hound` | 3.5.1 | WAV file I/O |
| `rubato` | 2.0.0 | Sample rate conversion (resampling) |
| `tempfile` | 3.27.0 | Temporary file handling |
| `memmap2` | 0.9 | Memory-mapped file access for zero-copy PCM reads |

## Module Structure

```
src/
├── lib.rs            # NIF entry point — registers 15 exported functions + 2 ResourceArc types
├── state.rs          # SynthState struct (NifMap derive — 29 fields)
├── engine.rs         # Render orchestrator — builds and runs signal chain (stateless)
├── voice.rs          # Streaming voice — persistent DSP state across render calls (stateful)
├── interface.rs      # Wire frame assembly (header + FFT + PCM)
├── mixer.rs          # Multi-voice mixing + soft limiting
├── waveform.rs       # Waveform peak generation for timeline thumbnails
├── timeline/         # Timeline playback sub-module
│   ├── mod.rs            # ProjectEngine struct, ProjectEngineResource, TrackParams
│   ├── decoder.rs        # symphonia decode → rubato resample → mono → tempfile
│   ├── mmap_store.rs     # MmapStore: HashMap<track_id, MmapEntry> for zero-copy reads
│   ├── interval_tree.rs  # ClipInfo + ClipTree (sorted vec, O(log n + k) query)
│   └── chunk_mixer.rs    # Hot path: query tree → read mmap → volume mix → FFT → frame
└── dsp/
    ├── mod.rs          # Re-exports all DSP sub-modules
    ├── oscillators.rs  # UnisonOscillator, build_unison_oscillator
    ├── filters.rs      # FilterType (SVF / Moog / Highpass / Bandpass), build_filter
    ├── effects.rs      # Drive, Distortion, Chorus, Reverb
    ├── envelope.rs     # ADSR envelope generator (amp + filter modulation)
    ├── lfo.rs          # Lfo struct, LfoTarget enum
    └── fft.rs          # compute_fft_spectrum, FFT_SIZE = 512
```

## NIF Functions

All NIFs are defined in `lib.rs` and exposed to Elixir via the `Backend.DSP` module.

### Synthesizer NIFs (stateless, pure functions)

| NIF | Schedule | Elixir Signature | Description |
|---|---|---|---|
| `ping` | Normal | `ping() :: String.t()` | Health check — returns `"pong"` |
| `generate_tone` | Normal | `generate_tone(freq, dur, sr) :: binary()` | Sine wave test tone |
| `render_synth` | DirtyCpu | `render_synth(state, dur) :: binary()` | Full synth render → wire frame (header + FFT + PCM) |
| `render_voice_pcm` | DirtyCpu | `render_voice_pcm(state, dur) :: binary()` | Single voice render → raw PCM binary (no header/FFT) |
| `mix_voices` | DirtyCpu | `mix_voices(pcm_list, offsets, total) :: binary()` | Mix multiple voices → wire frame |
| `generate_waveform_peaks` | DirtyCpu | `generate_waveform_peaks(pcm, bins) :: [{float, float}]` | Amplitude peaks for timeline thumbnails |

### Streaming Voice NIFs (stateful, ResourceArc-backed)

| NIF | Schedule | Elixir Signature | Description |
|---|---|---|---|
| `create_synth_voice` | Normal | `create_synth_voice(state, freq) :: reference()` | Create persistent voice (returns ResourceArc) |
| `render_voice_chunk` | Normal | `render_voice_chunk(voice, num_samples) :: binary()` | Render next N samples → wire frame |
| `voice_note_off` | Normal | `voice_note_off(voice) :: :ok` | Trigger ADSR release phase |
| `voice_is_done` | Normal | `voice_is_done(voice) :: boolean()` | Check if voice can be destroyed |

### Timeline NIFs (stateful, ResourceArc-backed)

| NIF | Schedule | Elixir Signature | Description |
|---|---|---|---|
| `init_engine` | Normal | `init_engine(project_id) :: reference()` | Create timeline engine (returns ResourceArc) |
| `decode_and_load_track` | DirtyCpu | `decode_and_load_track(engine, track_id, bytes, start_ms, offset_ms) :: :ok` | Decode + mmap audio file |
| `rebuild_timeline` | Normal | `rebuild_timeline(engine, clips) :: :ok` | Atomically replace interval tree |
| `set_track_params` | Normal | `set_track_params(engine, params) :: :ok` | Update volume/mute/pan per track |
| `mix_chunk` | DirtyCpu | `mix_chunk(engine, start_ms, duration_ms) :: binary()` | Mix timeline chunk → wire frame |

### ResourceArc Types

Two `ResourceArc` types are registered in `on_load`:

| Type | Wrapper | Purpose |
|---|---|---|
| `ProjectEngine` | `ProjectEngineResource(Mutex<ProjectEngine>)` | Timeline state: mmap store, interval tree, track params |
| `SynthVoice` | `SynthVoiceResource(Mutex<SynthVoice>)` | Streaming voice: oscillators, envelopes, filters, effects |

## SynthState (29 fields)

Defined in `state.rs`. Uses Rustler's `NifMap` derive to automatically decode from an Elixir map with atom keys:

```rust
#[derive(Debug, Clone, NifMap)]
pub struct SynthState {
    // Oscillator
    pub osc_shape: String,           // "saw" | "sine" | "square" | "triangle" | "noise"
    pub frequency: f32,              // Hz (20–20000)
    pub unison_voices: i32,          // 1–7
    pub unison_detune: f32,          // cents (0–50)
    pub unison_spread: f32,          // 0.0–1.0

    // Filter
    pub cutoff: f32,                 // Hz (20–18000)
    pub resonance: f32,              // 0.0–1.0
    pub filter_type: String,         // "svf" | "moog" | "highpass" | "bandpass"

    // Drive / Distortion
    pub drive: f32,                  // 1.0–20.0 (tanh saturation multiplier)
    pub distortion_type: String,     // "off" | "soft_clip" | "hard_clip" | "atan"
    pub distortion_amount: f32,      // 0.0–1.0

    // LFO
    pub lfo_rate: f32,               // Hz (0.1–20.0)
    pub lfo_depth: f32,              // 0.0–1.0
    pub lfo_shape: String,           // "sine" | "triangle" | "square" | "saw"
    pub lfo_target: String,          // "cutoff" | "pitch" | "volume"

    // Chorus
    pub chorus_rate: f32,            // Hz (0.1–5.0)
    pub chorus_depth: f32,           // 0.0–1.0
    pub chorus_mix: f32,             // dry/wet (0.0–1.0)

    // Reverb
    pub reverb_decay: f32,           // feedback (0.0–0.95)
    pub reverb_mix: f32,             // dry/wet (0.0–1.0)

    // Amplitude
    pub volume: f32,                 // 0.0–1.0

    // Amp ADSR Envelope
    pub amp_attack_ms: f32,          // 0–5000 ms
    pub amp_decay_ms: f32,           // 0–5000 ms
    pub amp_sustain: f32,            // 0.0–1.0
    pub amp_release_ms: f32,         // 0–5000 ms

    // Filter ADSR Envelope
    pub filter_attack_ms: f32,       // 0–5000 ms
    pub filter_decay_ms: f32,        // 0–5000 ms
    pub filter_sustain: f32,         // 0.0–1.0
    pub filter_release_ms: f32,      // 0–5000 ms
    pub filter_env_depth: f32,       // Hz (cutoff sweep amount)
}
```

## Signal Chain

```
  Unison Oscillators (1–7 detuned voices, √N gain staging)
         │
         ▼
  Filter (SVF / Moog / Highpass / Bandpass)
  ├─ cutoff modulated by LFO + Filter ADSR envelope
  └─ rebuilt every 64 samples (block-rate)
         │
         ▼
  Drive (tanh saturation, gain 1.0–20.0)
         │
         ▼
  Distortion (soft clip / hard clip / atan)
         │
         ▼
  Amp ADSR Envelope (gates amplitude, prevents clicks)
         │
         ▼
  Chorus (modulated delay line)
         │
         ▼
  Reverb (4-tap feedback delay network)
         │
         ▼
  Volume (linear gain, optional LFO volume modulation)
         │
         ▼
  FFT spectrum (512-point) + Wire frame assembly
```

### Render Functions (stateless — engine.rs)

- `render(state, sample_rate, duration_secs)` → `(Vec<f32>, FftBytes)` — Full render with auto note-off near end.
- `render_voice_with_release(state, sample_rate, note_duration_secs, release_secs)` → `Vec<f32>` — Bar voice with explicit note-off.
- `render_pcm_only(state, sample_rate, duration_secs)` → `Vec<f32>` — Wraps `render()`, discards FFT.

### Streaming Voice (stateful — voice.rs)

`SynthVoice` retains all DSP state between `render_chunk()` calls:

- **Persistent state**: oscillator phase, ADSR position, filter coefficients, LFO phase, chorus delay buffer, reverb FDN state.
- **Pre-allocated output**: `Vec<f32>` with capacity for 200 ms (8820 samples).
- **Voice culling**: Done when amp envelope is Off AND peak output < 0.00001 for a full chunk.
- **Used by**: `VoiceStreamer` GenServer for streaming keyboard note preview.

**Constants**: `SAMPLE_RATE = 44_100.0`, `BLOCK_SIZE = 64`, `SILENCE_THRESHOLD = 0.00001`, `MAX_CHUNK_SAMPLES = 8820`.

## DSP Sub-modules

### Oscillators (`dsp/oscillators.rs`)

**`UnisonOscillator`**: Renders 1–7 detuned oscillator voices using fundsp band-limited primitives.

| Shape | fundsp Node | Waveform |
|---|---|---|
| `"saw"` | `saw_hz(freq)` | Sawtooth (band-limited) |
| `"sine"` | `sine_hz(freq)` | Sine wave |
| `"square"` | `square_hz(freq)` | Square wave (band-limited) |
| `"triangle"` | `triangle_hz(freq)` | Triangle wave |
| `"noise"` | `noise()` | White noise |

### ADSR Envelope (`dsp/envelope.rs`)

Per-sample envelope generator with two independent instances (amp + filter).

| Phase | Curve | Description |
|---|---|---|
| Attack | Linear | 0 → 1 over `attack_s` seconds |
| Decay | Exponential (`e^(-5t)`) | 1 → sustain level |
| Sustain | Constant | Holds until `note_off()` |
| Release | Exponential (`e^(-5t)`) | Current level → 0 |
| Off | Zero | Returns 0.0 |

### Filters (`dsp/filters.rs`)

| Type | fundsp Node | Character |
|---|---|---|
| `"svf"` | `lowpass_hz(freq, q)` | Clean, transparent lowpass |
| `"moog"` | `moog_hz(freq, q)` | Warm, resonant analog-style lowpass |
| `"highpass"` | `highpass_hz(freq, q)` | Removes frequencies below cutoff |
| `"bandpass"` | `bandpass_hz(freq, q)` | Passes a band around cutoff |

**Q mapping**: Resonance [0.0, 1.0] → Q [0.707, 10.0].

### Effects (`dsp/effects.rs`)

| Effect | Description |
|---|---|
| Drive | `tanh()` waveshaper, gain 1.0–20.0 |
| Soft Clip | `tanh(x × (1 + amount × 4))` |
| Hard Clip | `clamp(x × (1 + amount × 4), -1, 1)` |
| Atan | `atan(x × (1 + amount × 4)) × (2/π)` |
| Chorus | Modulated delay (5 ms base, 5 ms depth, sinusoidal LFO, dry/wet) |
| Reverb | 4-tap FDN (primes: 1117, 1327, 1523, 1733), Hadamard mixing, `tanh` feedback |

### LFO (`dsp/lfo.rs`)

Block-rate modulation (every 64 samples). Shapes: sine, triangle, square, saw. Targets: cutoff (+4000 Hz), pitch, volume (+0.5).

### FFT (`dsp/fft.rs`)

512-point FFT with Hann window. Magnitude mapped [−80 dB, 0 dB] → [0, 255]. Output: `[u8; 512]`.

## Wire Frame Assembly (`interface.rs`)

```
Offset   Size          Content
───────────────────────────────────────────────
0        1 byte        Message type (1=mixer, 2=synth)
1–3      3 bytes       Padding (byte 1 = MIDI for voice_audio)
4–515    512 bytes     FFT spectrum (0–255)
516+     N × 4 bytes   PCM samples (f32 LE, −1.0 to 1.0)
```

## Voice Mixing (`mixer.rs`)

For polyphonic bar rendering: additive mixing at sample offsets → `tanh` soft limiting → FFT → wire frame.

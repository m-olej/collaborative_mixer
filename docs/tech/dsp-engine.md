# DSP Engine

The Rust DSP engine is compiled as a BEAM NIF (Native Implemented Function) via the Rustler framework. It handles all audio synthesis, signal processing, spectral analysis, and voice mixing.

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

## Module Structure

```
src/
├── lib.rs            # NIF entry point — registers 5 exported functions
├── state.rs          # SynthState struct (NifMap derive)
├── engine.rs         # Render orchestrator — builds and runs signal chain
├── interface.rs      # Wire frame assembly (header + FFT + PCM)
├── mixer.rs          # Multi-voice mixing + soft limiting
└── dsp/
    ├── mod.rs        # Sub-module hub
    ├── oscillators.rs # Unison oscillator stack
    ├── filters.rs     # SVF and Moog lowpass filters
    ├── effects.rs     # Drive, distortion, chorus, reverb, volume
    ├── lfo.rs         # LFO modulation (4 shapes, 3 targets)
    └── fft.rs         # FFT spectrum computation
```

## NIF Functions

All NIFs are defined in `lib.rs` and exposed to Elixir via the `Backend.DSP` module.

| NIF | Schedule | Elixir Signature | Description |
|---|---|---|---|
| `ping` | Normal | `ping() :: String.t()` | Health check — returns `"pong"` |
| `generate_tone` | Normal | `generate_tone(freq, dur, sr) :: binary()` | Sine wave test tone |
| `render_synth` | DirtyCpu | `render_synth(state, dur) :: binary()` | Full synth render → wire frame (header + FFT + PCM) |
| `render_voice_pcm` | DirtyCpu | `render_voice_pcm(state, dur) :: binary()` | Single voice render → raw PCM binary (no header/FFT) |
| `mix_voices` | DirtyCpu | `mix_voices(pcm_list, offsets, total) :: binary()` | Mix multiple voices → wire frame |

**DirtyCpu scheduling**: Long-running NIFs run on dedicated BEAM dirty CPU scheduler threads, preventing starvation of the normal BEAM schedulers that handle Erlang/Elixir processes.

## SynthState

Defined in `state.rs`, this struct uses Rustler's `NifMap` derive to automatically decode from an Elixir map:

```rust
#[derive(NifMap)]
pub struct SynthState {
    // Oscillator
    pub osc_shape: String,        // "saw" | "sine" | "square" | "triangle"
    pub frequency: f32,           // Hz (20–2000 typical)
    pub unison_voices: i32,       // 1–7
    pub unison_detune: f32,       // cents (0–50)
    pub unison_spread: f32,       // stereo spread (0.0–1.0)

    // Filter
    pub cutoff: f32,              // Hz (20–18000)
    pub resonance: f32,           // 0.0–1.0
    pub filter_type: String,      // "svf" | "moog"

    // Drive / Distortion
    pub drive: f32,               // gain multiplier (1.0–20.0)
    pub distortion_type: String,  // "off" | "soft_clip" | "hard_clip" | "atan"
    pub distortion_amount: f32,   // 0.0–1.0

    // LFO
    pub lfo_rate: f32,            // Hz (0.1–20.0)
    pub lfo_depth: f32,           // 0.0–1.0
    pub lfo_shape: String,        // "sine" | "triangle" | "square" | "saw"
    pub lfo_target: String,       // "cutoff" | "pitch" | "volume"

    // Chorus
    pub chorus_rate: f32,         // Hz (0.1–5.0)
    pub chorus_depth: f32,        // 0.0–1.0
    pub chorus_mix: f32,          // dry/wet (0.0–1.0)

    // Reverb
    pub reverb_decay: f32,        // feedback (0.0–0.95)
    pub reverb_mix: f32,          // dry/wet (0.0–1.0)

    // Amplitude
    pub volume: f32,              // 0.0–1.0
}
```

## Signal Chain

The `engine.rs` module orchestrates the full synthesis pipeline:

```
                    ┌─────────────────────────────────────────────┐
                    │              Signal Chain                    │
                    │                                             │
 SynthState ───►   │  Unison Oscillators (1–7 voices)            │
                    │         │                                   │
                    │         ▼                                   │
                    │  LFO Modulation (cutoff / pitch / volume)  │
                    │         │                                   │
                    │         ▼                                   │
                    │  Drive (tanh saturation)                    │
                    │         │                                   │
                    │         ▼                                   │
                    │  Filter (SVF or Moog lowpass)               │
                    │         │                                   │
                    │         ▼                                   │
                    │  Distortion (soft clip / hard clip / atan)  │
                    │         │                                   │
                    │         ▼                                   │
                    │  Chorus (modulated delay line)              │
                    │         │                                   │
                    │         ▼                                   │
                    │  Reverb (4-tap FDN)                         │
                    │         │                                   │
                    │         ▼                                   │
                    │  Volume (linear gain)                       │
                    │         │                                   │
                    │         ▼                                   │
                    │  ┌── PCM Float32 samples ──┐               │
                    │  │                          │               │
                    │  ▼                          ▼               │
                    │  FFT Spectrum            Wire Frame         │
                    │  (512-point)             Assembly           │
                    └─────────────────────────────────────────────┘
```

### Render Functions

- `render(state, sample_rate, duration_secs)` → `(Vec<f32>, [u8; 512])` — Full render producing PCM samples and FFT spectrum.
- `render_pcm_only(state, sample_rate, duration_secs)` → `Vec<f32>` — PCM only (used for individual voice rendering in polyphonic bar renders).

**Constants**: `SAMPLE_RATE = 44_100.0`, LFO computed at block rate (every 64 samples).

## DSP Sub-modules

### Oscillators (`dsp/oscillators.rs`)

**`UnisonOscillator`**: Renders 1–7 detuned oscillator voices.

- **Detuning**: Symmetric around the center frequency. Each voice is detuned by `±(voice_index × detune_cents / (voices - 1))`.
- **Spread**: Per-voice gain varies from `1.0 - spread` to `1.0 + spread` across the stack.
- **Phase randomization**: Each voice starts at a random phase to avoid constructive interference peaks.
- **Normalization**: Output is divided by the number of voices.

Supported oscillator shapes (from fundsp):
| Shape | fundsp Node | Waveform |
|---|---|---|
| `"saw"` | `saw_hz(freq)` | Sawtooth |
| `"sine"` | `sine_hz(freq)` | Sine wave |
| `"square"` | `square_hz(freq)` | Square wave |
| `"triangle"` | `triangle_hz(freq)` | Triangle wave |

### Filters (`dsp/filters.rs`)

| Type | fundsp Node | Character |
|---|---|---|
| `"svf"` | `lowpass_hz(freq, q)` | Clean, state-variable filter |
| `"moog"` | `moog_hz(freq, q)` | Warm, resonant analog-style filter |

**Q mapping**: Resonance [0.0, 1.0] maps to Q [0.707 (Butterworth), 10.0 (high resonance)].

### Effects (`dsp/effects.rs`)

**Drive**: `fundsp::Tanh` waveshaper. Gain clamped to [1.0, 20.0].

**Distortion types**:
| Type | Algorithm |
|---|---|
| `"off"` | Bypass |
| `"soft_clip"` | `tanh(x × (1 + amount × 4))` |
| `"hard_clip"` | `clamp(x × (1 + amount × 4), -1, 1)` |
| `"atan"` | `atan(x × (1 + amount × 4)) × (2/π)` |

**Chorus**: Modulated delay line with:
- Circular buffer (2× sample rate capacity)
- Base delay: 5 ms
- Modulation depth: 5 ms
- Sinusoidal LFO for delay modulation
- Linear interpolation for sub-sample accuracy
- Dry/wet mix control

**Reverb**: 4-tap Feedback Delay Network (FDN):
- Delay lengths: 1117, 1327, 1523, 1733 samples (prime numbers for even mode distribution)
- Hadamard-like mixing matrix for decorrelation between taps
- Feedback with `tanh` saturation to prevent runaway
- Dry/wet mix control

**Volume**: Linear gain, clamped to [0.0, 1.0].

### LFO (`dsp/lfo.rs`)

Block-rate modulation (computed every 64 samples for efficiency).

**Shapes**:
| Shape | Waveform |
|---|---|
| `"sine"` | `sin(2π × phase)` |
| `"triangle"` | Piecewise linear: rises 0→1 in first half, falls 1→0 in second |
| `"square"` | +1 for first half, −1 for second |
| `"saw"` | Linear ramp from −1 to +1 |

**Targets**:
| Target | Modulation Effect |
|---|---|
| `"cutoff"` | Multiplies filter cutoff by `2^(lfo_value)` |
| `"pitch"` | Multiplies oscillator frequency by `2^(lfo_value × depth)` |
| `"volume"` | Multiplies gain by `(1 + lfo_value × depth)` |

### FFT (`dsp/fft.rs`)

- FFT size: 512 points
- Window: Hann (raised cosine)
- Magnitude: `20 × log10(|bin|)` → dBFS
- Mapping: [−80 dB, 0 dB] → [0, 255]
- Output: 512-byte `[u8; 512]` symmetric mirror

## Wire Frame Assembly (`interface.rs`)

Constructs the binary frame sent over WebSocket:

```rust
fn build_wire_frame(pcm: &[f32], fft: &[u8; 512]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(4 + 512 + pcm.len() * 4);
    frame.push(MSG_TYPE_SYNTH);  // byte 0: type = 2
    frame.extend_from_slice(&[0, 0, 0]);  // bytes 1-3: padding
    frame.extend_from_slice(fft);  // bytes 4-515: FFT
    for &sample in pcm {
        frame.extend_from_slice(&sample.to_le_bytes());  // bytes 516+: PCM LE f32
    }
    frame
}
```

## Voice Mixing (`mixer.rs`)

Used for polyphonic bar rendering where multiple notes are combined:

```
Voice 1 PCM (offset: 0) ─────────────┐
Voice 2 PCM (offset: 500) ───────────┤── Additive Mixing ──► Soft Limiter ──► FFT ──► Wire Frame
Voice 3 PCM (offset: 1200) ──────────┘      (sum)              (tanh)
```

1. **Additive mixing**: Each voice's PCM is added to the output buffer at its sample offset.
2. **Soft limiting**: Samples exceeding ±1.0 are compressed via `tanh()`.
3. **FFT computation**: Spectrum is computed from the mixed output.
4. **Frame assembly**: Standard wire frame with type byte, padding, FFT, and PCM.

## Elixir NIF Bridge (`lib/backend/dsp.ex`)

```elixir
defmodule Backend.DSP do
  use Rustler, otp_app: :backend, crate: "backend_dsp"

  def ping(),                             do: :erlang.nif_error(:nif_not_loaded)
  def generate_tone(_freq, _dur, _sr),    do: :erlang.nif_error(:nif_not_loaded)
  def render_synth(_state, _dur),         do: :erlang.nif_error(:nif_not_loaded)
  def render_voice_pcm(_state, _dur),     do: :erlang.nif_error(:nif_not_loaded)
  def mix_voices(_pcms, _offsets, _total), do: :erlang.nif_error(:nif_not_loaded)
end
```

Each function has a fallback that raises `:nif_not_loaded` if the native library isn't compiled. The Rustler build system compiles the `.so` automatically during `mix compile`.

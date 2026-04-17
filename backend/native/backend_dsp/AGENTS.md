# Cloud DAW — Rust DSP Engine Agent Guide

> Rust NIF crate (`backend_dsp`). Read root `AGENTS.md` first for cross-cutting concerns.
> This crate is compiled via `mix compile` (Rustler). Never run `cargo` directly in CI; let Mix manage the build.

---

## 1. Crate Identity

| Key              | Value                                      |
|------------------|--------------------------------------------|
| Crate name       | `backend_dsp`                              |
| Crate type       | `cdylib` (shared library loaded by BEAM)   |
| Rust edition     | 2021                                       |
| Rustler version  | 0.37.3                                     |
| Elixir NIF module| `Elixir.Backend.DSP`                       |
| Entry point      | `native/backend_dsp/src/lib.rs`            |
| Workspace root   | `backend/Cargo.toml`                       |

---

## 2. Dependencies Reference

| Crate     | Version | Purpose                                                              |
|-----------|---------|----------------------------------------------------------------------|
| rustler   | 0.37.3  | Erlang NIF bindings — exposes Rust functions to Elixir               |
| symphonia | 0.5.5 (`features = ["all"]`) | Decode audio files (WAV, MP3, FLAC, OGG) into PCM |
| biquad    | 0.6.0   | Biquad IIR filters for parametric EQ (low-shelf, high-shelf, peaking)|
| rustfft   | 6.4.1   | Fast Fourier Transform for FFT spectrum data                         |
| hound     | 3.5.1   | Write WAV files for project export                                   |
| rubato    | 2.0.0   | Sample rate conversion (resampling) to normalize track rates          |
| tempfile  | 3.27.0  | Write in-progress render files to temp paths before finalizing       |

---

## 3. CRITICAL: BEAM Scheduler Safety (Dirty NIFs)

BEAM assumes NIFs complete in **< 1 millisecond**. Any NIF that runs longer will block the scheduler thread and starve all other Erlang processes — potentially crashing the entire application.

### Rule: All heavy DSP functions MUST be Dirty NIFs

```rust
// ✅ CORRECT — does not block scheduler
#[rustler::nif(schedule = "DirtyCpu")]
fn render_wav(export_id: u64) -> NifResult<String> {
    // ... may take seconds ...
}

// ✅ CORRECT alternative — offload to OS thread
#[rustler::nif(schedule = "DirtyCpu")]
fn mix_and_stream(tracks: Vec<TrackInfo>, settings: MixSettings) -> NifResult<Vec<u8>> {
    // Mix happens in this DirtyCpu context
}

// ❌ WRONG — will hang the BEAM scheduler for all users
#[rustler::nif]  // no schedule = DirtyCpu
fn render_wav(export_id: u64) -> NifResult<String> { ... }
```

### Classification

| NIF function       | Schedule         | Reason                              |
|--------------------|------------------|-------------------------------------|
| `ping`             | Default (fast)   | Trivial, microseconds               |
| `mix_and_stream`   | `DirtyCpu`       | Mixes audio buffers (milliseconds)  |
| `render_wav`       | `DirtyCpu`       | Full project render (seconds)       |
| `decode_audio_file`| `DirtyCpu`       | File I/O + decoding                 |

---

## 4. NIF Registration Pattern

All public NIFs must be registered in `rustler::init!`:

```rust
rustler::init!("Elixir.Backend.DSP", [
    ping,
    mix_and_stream,
    render_wav,
    decode_audio_file,
]);
```

The string `"Elixir.Backend.DSP"` must match the Elixir module name exactly (dot-separated, `Elixir.` prefix).

---

## 5. Current NIF Stubs (lib.rs)

```rust
use rustler::{Atom, NifResult};

mod atoms {
    rustler::atoms! {
        ok,
        error,
    }
}

#[rustler::nif]
fn ping() -> NifResult<String> {
    Ok("Rust DSP Engine is online!".to_string())
}

rustler::init!("Elixir.Backend.DSP", [ping]);
```

---

## 6. Planned NIF Interface

### `decode_audio_file`

Decodes an audio file (WAV/MP3/FLAC) to normalized `f32` PCM samples at target sample rate.

```rust
#[rustler::nif(schedule = "DirtyCpu")]
fn decode_audio_file(path: String, target_sample_rate: u32) -> NifResult<Vec<f32>> {
    // 1. Open file with symphonia
    // 2. Decode to interleaved f32 PCM
    // 3. Resample to target_sample_rate using rubato
    // 4. Return mono-mixed Vec<f32>
}
```

**Libraries:** `symphonia` for decode, `rubato` for resampling.

### `mix_and_stream`

Mixes multiple tracks into one stereo master frame, applies EQ, and returns the binary frame for WebSocket broadcast.

```rust
#[derive(NifStruct)]
#[module = "Backend.DSP.TrackInfo"]
struct TrackInfo {
    samples: Vec<f32>,  // pre-decoded PCM
    volume: f32,        // 0.0–1.0
    muted: bool,
    eq: EqSettings,
}

#[derive(NifStruct)]
#[module = "Backend.DSP.EqSettings"]
struct EqSettings {
    low_gain_db: f32,
    mid_gain_db: f32,
    high_gain_db: f32,
}

#[rustler::nif(schedule = "DirtyCpu")]
fn mix_and_stream(
    tracks: Vec<TrackInfo>,
    frame_start: usize,
    frame_size: usize,
) -> NifResult<rustler::types::binary::OwnedBinary> {
    // 1. Sum track samples scaled by volume (skip muted)
    // 2. Apply biquad EQ filters per track
    // 3. Compute FFT on mixed output (rustfft → 512 Uint8 bins)
    // 4. Pack binary frame: [type_byte, 3×padding, 512×fft_u8, N×pcm_f32]
    // 5. Return OwnedBinary
}
```

### `render_wav`

Renders the complete project to a temporary WAV file and returns the file path.

```rust
#[rustler::nif(schedule = "DirtyCpu")]
fn render_wav(
    tracks: Vec<TrackInfo>,
    sample_rate: u32,
    output_path: String,
) -> NifResult<String> {
    // 1. Mix all tracks for their full duration
    // 2. Write to tempfile::NamedTempFile using hound::WavWriter
    // 3. Move file to output_path when complete
    // 4. Return final path
}
```

---

## 7. Binary Frame Packing (Rust Implementation)

The frame layout is fixed — match it exactly:

```rust
fn pack_audio_frame(fft_bins: &[u8; 512], pcm: &[f32]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(1 + 3 + 512 + pcm.len() * 4);
    frame.push(1u8);                    // message type = audio
    frame.extend_from_slice(&[0u8; 3]); // padding (4-byte alignment)
    frame.extend_from_slice(fft_bins);  // 512 FFT bytes
    for &sample in pcm {
        frame.extend_from_slice(&sample.to_le_bytes()); // Little Endian f32
    }
    frame
}
```

**Total header size:** 516 bytes (1 + 3 + 512). JS reads `Float32Array(buffer, 516)`.

---

## 8. FFT Computation (rustfft → Uint8 bins)

```rust
use rustfft::{FftPlanner, num_complex::Complex};

fn compute_fft_bins(pcm: &[f32], num_bins: usize) -> Vec<u8> {
    let fft_size = num_bins * 2; // e.g. 1024 for 512 bins
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(fft_size);

    let mut buffer: Vec<Complex<f32>> = pcm.iter()
        .take(fft_size)
        .map(|&s| Complex { re: s, im: 0.0 })
        .collect();
    // zero-pad if needed
    buffer.resize(fft_size, Complex { re: 0.0, im: 0.0 });

    fft.process(&mut buffer);

    // Take first half (positive frequencies), compute magnitude, scale to 0–255
    buffer.iter()
        .take(num_bins)
        .map(|c| {
            let mag = (c.norm() / fft_size as f32 * 2.0).min(1.0);
            (mag * 255.0) as u8
        })
        .collect()
}
```

---

## 9. EQ Filtering (biquad)

```rust
use biquad::{Biquad, Coefficients, DirectForm1, ToHertz, Type, Q_BUTTERWORTH_F32};

fn apply_eq(samples: &mut Vec<f32>, sample_rate: f32, settings: &EqSettings) {
    // Low shelf
    if settings.low_gain_db.abs() > 0.01 {
        let coeffs = Coefficients::<f32>::from_params(
            Type::LowShelf(settings.low_gain_db),
            sample_rate.hz(),
            200.0.hz(),
            Q_BUTTERWORTH_F32,
        ).unwrap();
        let mut filter = DirectForm1::<f32>::new(coeffs);
        for s in samples.iter_mut() { *s = filter.run(*s); }
    }
    // High shelf (similar, use 8000.hz() cutoff)
    // Mid peaking (use Type::PeakingEQ)
}
```

---

## 10. Audio Decoding with Symphonia

```rust
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use std::fs::File;

fn decode_to_f32(path: &str) -> Vec<f32> {
    let file = File::open(path).expect("open audio file");
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    // hint.with_extension("mp3"); // optional
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .expect("probe format");
    let mut format = probed.format;
    let track = format.default_track().expect("find track");
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .expect("make decoder");

    let mut samples = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break,
        };
        let decoded = decoder.decode(&packet).expect("decode packet");
        let spec = *decoded.spec();
        let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buf.copy_interleaved_ref(decoded);
        samples.extend_from_slice(buf.samples());
    }
    samples
}
```

---

## 11. Resampling with Rubato

```rust
use rubato::{FftFixedIn, Resampler};

fn resample(samples: Vec<f32>, from_rate: usize, to_rate: usize) -> Vec<f32> {
    if from_rate == to_rate { return samples; }
    let chunk_size = 1024;
    let mut resampler = FftFixedIn::<f32>::new(from_rate, to_rate, chunk_size, 2, 1)
        .expect("create resampler");
    let waves_in = vec![samples];
    let mut output = Vec::new();
    for chunk in waves_in[0].chunks(chunk_size) {
        let padded = [chunk.to_vec()]; // channel 0
        let out = resampler.process(&padded, None).expect("resample chunk");
        output.extend_from_slice(&out[0]);
    }
    output
}
```

---

## 12. WAV Export with Hound + Tempfile

```rust
use hound::{WavSpec, WavWriter, SampleFormat};
use tempfile::NamedTempFile;

fn write_wav(samples: &[f32], sample_rate: u32, final_path: &str) -> std::io::Result<()> {
    let temp = NamedTempFile::new()?;
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };
    let mut writer = WavWriter::new(temp.reopen()?, spec).expect("create writer");
    for &s in samples {
        writer.write_sample(s).expect("write sample");
    }
    writer.finalize().expect("finalize wav");
    temp.persist(final_path)?;
    Ok(())
}
```

---

## 13. Error Handling in NIFs

- **Never panic** inside a NIF — a panic kills the BEAM scheduler thread.
- Return `NifResult<T>` (which is `Result<T, rustler::Error>`).
- Map Rust errors to `Err(rustler::Error::Term(Box::new(atoms::error())))`.

```rust
#[rustler::nif(schedule = "DirtyCpu")]
fn render_wav(path: String) -> NifResult<String> {
    do_render(&path).map_err(|e| {
        // Log via eprintln! (goes to Erlang logger)
        eprintln!("render_wav error: {e}");
        rustler::Error::Term(Box::new(atoms::error()))
    })
}
```

---

## 14. Data Format Invariants

- All internal audio data: `f32`, range −1.0 to 1.0 (clamp after mixing to prevent clipping).
- All byte order: **Little Endian** (Rust default for `f32::to_le_bytes()`).
- Sample rate standard: 44100 Hz (all tracks resampled to this via rubato before mixing).
- FFT bins: 512 Uint8 values (0–255), computed from 1024-point FFT of mixed output.
- Frame PCM chunk size: match the AudioWorklet block size (typically 128 samples per frame, adjustable).

---

## 15. Build Notes

```bash
# Build is triggered by Mix — do NOT run cargo manually in CI
mix compile          # compiles Elixir + Rust NIF

# Local Rust check (optional, for fast iteration)
cd native/backend_dsp
cargo check
cargo clippy -- -D warnings
```

The compiled `.so` / `.dylib` is placed in `priv/native/` by Rustler automatically.

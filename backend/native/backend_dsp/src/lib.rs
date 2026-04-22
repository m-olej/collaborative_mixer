//! Rustler NIF entry point for the Cloud DAW DSP engine.
//!
//! # Module registration
//! The string `"Elixir.Backend.DSP"` maps this crate to the `Backend.DSP`
//! Elixir module.  Every function listed in `rustler::init!` becomes callable
//! from Elixir once the crate is compiled and its `.so` is loaded.
//!
//! # Dirty CPU scheduler
//! `render_synth` renders up to several seconds of audio (~44 100 × duration
//! floating-point operations) and MUST carry `schedule = "DirtyCpu"`.
//! Without that annotation the BEAM's regular scheduler thread is blocked
//! for the entire duration of the NIF, starving every other Elixir process on
//! that scheduler core.  DirtyCpu NIFs run on a separate thread pool that is
//! outside the regular scheduler, so they cannot cause this starvation.
//!
//! # Memory ownership across the NIF boundary
//! `render_synth` returns a `Binary<'a>` backed by an `OwnedBinary` — memory
//! allocated directly on the Erlang heap via `enif_alloc_binary`.  The data
//! is written into that allocation once (via `copy_from_slice`) and then the
//! BEAM owns it.  There is no intermediate OS-heap allocation visible to the
//! GC.

use rustler::{Binary, Env, NifResult, OwnedBinary};

// Sub-modules — each has a single responsibility.
mod atoms {
    rustler::atoms! { ok, error }
}

/// Synthesizer parameter struct decoded from an Elixir map.
mod state;

/// DSP sub-modules: oscillators, filters, effects, FFT.
/// Each sub-module encapsulates one processing type and exposes
/// a factory function returning `Box<dyn AudioUnit>`.
mod dsp;

/// DSP rendering orchestrator — wires the fundsp nodes from `dsp::*`.
mod engine;

/// Binary wire-frame assembly (header + FFT + PCM).
mod interface;

/// Voice mixing and limiting for polyphonic bar rendering.
mod mixer;

use engine::{render, render_pcm_only, SAMPLE_RATE};
use interface::build_synth_frame;
use state::SynthState;

// ---------------------------------------------------------------------------
// NIFs
// ---------------------------------------------------------------------------

/// Health-check NIF — synchronous, completes in microseconds.
/// Does NOT need DirtyCpu.
#[rustler::nif]
fn ping() -> NifResult<String> {
    Ok("Rust DSP Engine is online!".to_string())
}

/// Simple sine-wave generator kept for backwards compatibility / testing.
/// Returns a `Vec<f32>` which Rustler encodes as an Erlang list of floats.
#[rustler::nif]
fn generate_tone(frequency: f32, sample_rate: f32, duration_secs: f32) -> NifResult<Vec<f32>> {
    let total_samples = (sample_rate * duration_secs) as usize;
    let mut samples = Vec::with_capacity(total_samples);

    for n in 0..total_samples {
        let t = n as f32 / sample_rate;
        let sample = (2.0 * std::f32::consts::PI * frequency * t).sin();
        samples.push(sample);
    }

    Ok(samples)
}

/// Render a synthesized audio frame from the given synth parameters.
///
/// # NIF boundary — decoding
/// `state` is automatically decoded by Rustler from a plain Elixir map:
/// ```elixir
/// %{osc_shape: "saw", frequency: 440.0, cutoff: 2500.0,
///   resonance: 0.7, drive: 1.2, volume: 0.8}
/// ```
/// Rustler reads this map on the BEAM stack — no Elixir heap allocation.
///
/// # NIF boundary — encoding
/// The returned `Binary<'a>` is backed by an `OwnedBinary` allocated via
/// `enif_alloc_binary` on the Erlang heap.  Frame bytes are written once
/// with `copy_from_slice`; the BEAM takes ownership immediately after the
/// NIF returns, with no further copying.
///
/// # Wire format
/// The binary follows AGENTS.md §5:
/// ```
/// byte 0:    message type = 2  (synth buffer)
/// bytes 1-3: zero padding
/// bytes 4-515: FFT magnitude spectrum (Uint8Array(512))
/// bytes 516+:  PCM f32 samples, little-endian (Float32Array)
/// ```
///
/// # DirtyCpu — mandatory
/// This function performs `sample_rate * duration_secs` DSP iterations
/// (e.g. 44 100 iterations for 1 second).  Flagging it DirtyCpu moves
/// execution to a dedicated OS thread pool, keeping the BEAM scheduler free.
#[rustler::nif(schedule = "DirtyCpu")]
fn render_synth<'a>(env: Env<'a>, state: SynthState, duration_secs: f64) -> NifResult<Binary<'a>> {
    // Render PCM and FFT from the synthesizer parameter struct.
    let (pcm, fft) = render(&state, SAMPLE_RATE, duration_secs as f32);

    // Assemble the complete binary wire frame.
    let frame_bytes = build_synth_frame(&fft, &pcm);

    // Allocate an OwnedBinary on the Erlang heap.
    // `ok_or` converts the Option failure into a Rustler BadArg error,
    // which surfaces as a raised exception on the Elixir side.
    let mut owned = OwnedBinary::new(frame_bytes.len()).ok_or(rustler::Error::BadArg)?;

    // Single copy: OS heap -> Erlang heap.  After `release`, BEAM owns the memory.
    owned.as_mut_slice().copy_from_slice(&frame_bytes);

    Ok(owned.release(env))
}

/// Render a single voice as raw PCM for polyphonic bar rendering.
///
/// Returns a binary containing f32 LE PCM samples (no header, no FFT).
/// The Elixir caller spawns one Task per voice, each calling this NIF
/// concurrently.  The results are then mixed by `mix_voices/3`.
#[rustler::nif(schedule = "DirtyCpu")]
fn render_voice_pcm<'a>(
    env: Env<'a>,
    state: SynthState,
    duration_secs: f64,
) -> NifResult<Binary<'a>> {
    let pcm = render_pcm_only(&state, SAMPLE_RATE, duration_secs as f32);

    let byte_len = pcm.len() * 4;
    let mut owned = OwnedBinary::new(byte_len).ok_or(rustler::Error::BadArg)?;
    let buf = owned.as_mut_slice();
    for (i, &sample) in pcm.iter().enumerate() {
        buf[i * 4..(i + 1) * 4].copy_from_slice(&sample.to_le_bytes());
    }

    Ok(owned.release(env))
}

/// Mix multiple rendered voice PCM buffers into a single wire frame.
///
/// # Arguments (from Elixir)
/// * `pcm_binaries` – list of binaries, each containing f32 LE PCM samples.
/// * `offsets`       – list of integers, start sample index for each voice.
/// * `total_samples` – total number of samples in the output bar.
///
/// # Returns
/// A complete binary wire frame (header + FFT + mixed PCM).
#[rustler::nif(schedule = "DirtyCpu")]
fn mix_voices<'a>(
    env: Env<'a>,
    pcm_binaries: Vec<Binary<'a>>,
    offsets: Vec<i64>,
    total_samples: i64,
) -> NifResult<Binary<'a>> {
    let total = total_samples.max(0) as usize;

    // Decode each PCM binary (f32 LE bytes) into a Vec<f32>.
    let voice_pcms: Vec<Vec<f32>> = pcm_binaries
        .iter()
        .map(|bin| {
            bin.as_slice()
                .chunks_exact(4)
                .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                .collect()
        })
        .collect();

    let voice_refs: Vec<&[f32]> = voice_pcms.iter().map(|v| v.as_slice()).collect();
    let offset_usizes: Vec<usize> = offsets.iter().map(|&o| o.max(0) as usize).collect();

    let frame = mixer::mix_and_build_frame(&voice_refs, &offset_usizes, total);

    let mut owned = OwnedBinary::new(frame.len()).ok_or(rustler::Error::BadArg)?;
    owned.as_mut_slice().copy_from_slice(&frame);

    Ok(owned.release(env))
}

// ---------------------------------------------------------------------------
// NIF registration — must list every exported NIF exactly once.
// The module name must match `Backend.DSP` (the Elixir module using Rustler).
// ---------------------------------------------------------------------------
rustler::init!("Elixir.Backend.DSP");

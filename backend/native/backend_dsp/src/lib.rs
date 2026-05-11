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

use rustler::{Binary, Env, NifResult, OwnedBinary, ResourceArc};

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

/// Waveform peak generation for timeline thumbnail display.
mod waveform;

/// Timeline playback engine: mmap store, interval tree, chunk mixer, decoder.
/// Completely independent from the synthesizer pipeline above.
mod timeline;

/// Stateful synthesizer voice for streaming note preview.
mod voice;

use engine::{render, render_pcm_only, render_voice_with_release, SAMPLE_RATE};
use interface::build_synth_frame;
use state::SynthState;
use timeline::{interval_tree::ClipInfo, ProjectEngine, ProjectEngineResource, TrackParams};
use voice::{SynthVoice, SynthVoiceResource};

use std::sync::Mutex;

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
///
/// `note_duration_secs` controls when note-off fires; the total rendered
/// PCM includes the ADSR release tail.
#[rustler::nif(schedule = "DirtyCpu")]
fn render_voice_pcm<'a>(
    env: Env<'a>,
    state: SynthState,
    duration_secs: f64,
) -> NifResult<Binary<'a>> {
    let release_secs = state.amp_release_ms / 1000.0;
    let pcm = render_voice_with_release(&state, SAMPLE_RATE, duration_secs as f32, release_secs);

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

/// Generate waveform peaks from raw PCM audio data for timeline thumbnails.
///
/// # Arguments (from Elixir)
/// * `audio_binary` — binary containing f32 LE PCM samples.
/// * `num_bins`     — number of output bins (typically ~200).
///
/// # Returns
/// A list of `%{min: f32, max: f32}` maps for Elixir consumption.
#[rustler::nif(schedule = "DirtyCpu")]
#[allow(unused_variables)]
fn generate_waveform_peaks<'a>(
    env: Env<'a>,
    audio_binary: Binary<'a>,
    num_bins: i64,
) -> NifResult<Vec<(f32, f32)>> {
    let bins = num_bins.max(1) as usize;

    // Decode f32 LE PCM from binary.
    let pcm: Vec<f32> = audio_binary
        .as_slice()
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();

    let peaks = waveform::compute_waveform_peaks(&pcm, bins);
    Ok(peaks)
}

// ===========================================================================
// Streaming voice NIFs — stateful ResourceArc-backed synth voices.
// ===========================================================================

/// Create a new SynthVoice for streaming note preview.
///
/// Returns a `ResourceArc<SynthVoiceResource>` that persists across render
/// calls, holding all DSP state (oscillators, envelopes, filters, effects).
///
/// This is cheap — just allocates the DSP structs.  Not DirtyCpu.
#[rustler::nif]
fn create_synth_voice(
    state: SynthState,
    frequency: f64,
) -> NifResult<ResourceArc<SynthVoiceResource>> {
    let voice = SynthVoice::new(&state, frequency as f32, SAMPLE_RATE);
    Ok(ResourceArc::new(SynthVoiceResource(Mutex::new(voice))))
}

/// Render the next `num_samples` from a persistent voice.
///
/// Returns a binary wire frame (header + FFT + PCM) ready for WebSocket push.
/// Executes in < 1 ms for 50 ms chunks (2205 samples) — normal scheduler is fine.
#[rustler::nif]
fn render_voice_chunk<'a>(
    env: Env<'a>,
    voice_resource: ResourceArc<SynthVoiceResource>,
    num_samples: u64,
) -> NifResult<Binary<'a>> {
    let mut voice = voice_resource
        .0
        .lock()
        .map_err(|_| rustler::Error::Term(Box::new("voice lock poisoned")))?;

    let frame = voice.render_chunk(num_samples as usize);

    let mut owned = OwnedBinary::new(frame.len()).ok_or(rustler::Error::BadArg)?;
    owned.as_mut_slice().copy_from_slice(&frame);
    Ok(owned.release(env))
}

/// Trigger the release phase on a voice (key-up event).
///
/// After this call, the voice continues rendering the ADSR release tail
/// and effects decay until `voice_is_done` returns true.
#[rustler::nif]
fn voice_note_off(voice_resource: ResourceArc<SynthVoiceResource>) -> NifResult<rustler::Atom> {
    let mut voice = voice_resource
        .0
        .lock()
        .map_err(|_| rustler::Error::Term(Box::new("voice lock poisoned")))?;

    voice.note_off();
    Ok(atoms::ok())
}

/// Check if a voice has finished (envelope done AND effects tail silent).
///
/// Returns `true` when the voice can be safely destroyed.
#[rustler::nif]
fn voice_is_done(voice_resource: ResourceArc<SynthVoiceResource>) -> NifResult<bool> {
    let voice = voice_resource
        .0
        .lock()
        .map_err(|_| rustler::Error::Term(Box::new("voice lock poisoned")))?;

    Ok(voice.is_done())
}

// ===========================================================================
// Timeline playback NIFs — completely separate pipeline from synth above.
// ===========================================================================

/// Allocate a new ProjectEngine for a project.
///
/// Returns a `ResourceArc` that Elixir holds as an opaque term.  The engine
/// is empty; tracks are loaded via `decode_and_load_track`.
///
/// This is cheap — just allocates the structs.  Not DirtyCpu.
#[rustler::nif]
fn init_engine(_project_id: u64) -> NifResult<ResourceArc<ProjectEngineResource>> {
    let engine = ProjectEngine::new(48_000);
    Ok(ResourceArc::new(ProjectEngineResource(Mutex::new(engine))))
}

/// Decode raw audio bytes and load them into the engine's mmap store + timeline.
///
/// # Arguments (from Elixir)
/// * `engine_resource` – `ResourceArc<ProjectEngineResource>` from `init_engine`.
/// * `track_id`        – integer ID matching the DB track.
/// * `audio_bytes`     – raw audio file bytes (WAV/MP3/FLAC from S3).
/// * `clip_start_ms`   – where this clip starts on the global timeline.
/// * `source_offset_ms`– offset into the decoded audio (usually 0).
///
/// # DirtyCpu — mandatory
/// File decoding + resampling can take hundreds of milliseconds.
#[rustler::nif(schedule = "DirtyCpu")]
fn decode_and_load_track<'a>(
    engine_resource: ResourceArc<ProjectEngineResource>,
    track_id: u64,
    audio_bytes: Binary<'a>,
    clip_start_ms: u64,
    source_offset_ms: u64,
) -> NifResult<u64> {
    let mut engine = engine_resource
        .0
        .lock()
        .map_err(|_| rustler::Error::Term(Box::new("engine lock poisoned")))?;

    // Decode audio bytes → tempfile with f32 LE PCM at engine sample rate.
    let (tmpfile, total_samples) =
        timeline::decoder::decode_to_tempfile(audio_bytes.as_slice(), engine.sample_rate)
            .map_err(|e| rustler::Error::Term(Box::new(format!("decode error: {e}"))))?;

    // Memory-map the tempfile and insert into the store.
    engine
        .store
        .insert(track_id, tmpfile, total_samples)
        .map_err(|e| rustler::Error::Term(Box::new(format!("mmap error: {e}"))))?;

    // Calculate clip end based on total decoded samples.
    let duration_ms = (total_samples as u64 * 1000) / engine.sample_rate as u64;
    let clip_end_ms = clip_start_ms + duration_ms;

    // Insert into the interval tree.
    engine.timeline.insert(ClipInfo {
        clip_id: track_id,
        track_id,
        start_ms: clip_start_ms,
        end_ms: clip_end_ms,
        source_offset_ms,
    });

    Ok(duration_ms)
}

/// Atomically replace the entire timeline with a new set of clips.
///
/// Called after track add/remove/move operations so the interval tree
/// matches the database state.
///
/// # Arguments
/// * `clips` – list of maps: `%{clip_id, track_id, start_ms, end_ms, source_offset_ms}`.
#[rustler::nif]
fn rebuild_timeline(
    engine_resource: ResourceArc<ProjectEngineResource>,
    clips: Vec<ClipInfoNif>,
) -> NifResult<rustler::Atom> {
    let mut engine = engine_resource
        .0
        .lock()
        .map_err(|_| rustler::Error::Term(Box::new("engine lock poisoned")))?;

    let clip_vec: Vec<ClipInfo> = clips
        .into_iter()
        .map(|c| ClipInfo {
            clip_id: c.clip_id,
            track_id: c.track_id,
            start_ms: c.start_ms,
            end_ms: c.end_ms,
            source_offset_ms: c.source_offset_ms,
        })
        .collect();

    engine.timeline.rebuild(clip_vec);
    Ok(atoms::ok())
}

/// Get the end timestamp (ms) of the last clip on the timeline.
///
/// Returns 0 if the timeline is empty.  Used by Elixir to implement
/// auto-stop when the playhead passes all clips.
#[rustler::nif]
fn get_timeline_end(engine_resource: ResourceArc<ProjectEngineResource>) -> NifResult<u64> {
    let engine = engine_resource
        .0
        .lock()
        .map_err(|_| rustler::Error::Term(Box::new("engine lock poisoned")))?;

    Ok(engine.timeline.max_end_ms())
}

/// Update per-track mixing parameters (volume, mute, pan).
///
/// Called on every slider_update.  Fast path — no DirtyCpu needed.
#[rustler::nif]
fn set_track_params(
    engine_resource: ResourceArc<ProjectEngineResource>,
    params: Vec<TrackParamUpdateNif>,
) -> NifResult<rustler::Atom> {
    let mut engine = engine_resource
        .0
        .lock()
        .map_err(|_| rustler::Error::Term(Box::new("engine lock poisoned")))?;

    for p in params {
        engine.params.insert(
            p.track_id,
            TrackParams {
                volume: p.volume,
                muted: p.muted,
                pan: p.pan,
            },
        );
    }

    Ok(atoms::ok())
}

/// Mix a chunk of timeline audio at the given playhead position.
///
/// Returns a complete wire frame (type byte 1) with FFT + PCM.
///
/// For sparse timelines with few overlapping clips this completes in < 1 ms
/// (regular scheduler is fine).  For dense timelines we mark DirtyCpu.
#[rustler::nif(schedule = "DirtyCpu")]
fn mix_chunk<'a>(
    env: Env<'a>,
    engine_resource: ResourceArc<ProjectEngineResource>,
    start_ms: u64,
    duration_ms: u32,
) -> NifResult<Binary<'a>> {
    let engine = engine_resource
        .0
        .lock()
        .map_err(|_| rustler::Error::Term(Box::new("engine lock poisoned")))?;

    let frame = timeline::chunk_mixer::mix_chunk(&engine, start_ms, duration_ms);

    let mut owned = OwnedBinary::new(frame.len()).ok_or(rustler::Error::BadArg)?;
    owned.as_mut_slice().copy_from_slice(&frame);
    Ok(owned.release(env))
}

// ── NIF helper structs (Rustler NifMap decode from Elixir maps) ────────────

/// Elixir map for `rebuild_timeline/2` clip list.
#[derive(rustler::NifMap)]
struct ClipInfoNif {
    clip_id: u64,
    track_id: u64,
    start_ms: u64,
    end_ms: u64,
    source_offset_ms: u64,
}

/// Elixir map for `set_track_params/2` parameter list.
#[derive(rustler::NifMap)]
struct TrackParamUpdateNif {
    track_id: u64,
    volume: f32,
    muted: bool,
    pan: f32,
}

// ---------------------------------------------------------------------------
// NIF registration — must list every exported NIF exactly once.
// The module name must match `Backend.DSP` (the Elixir module using Rustler).
// ---------------------------------------------------------------------------
rustler::init!("Elixir.Backend.DSP", load = on_load);

/// Called once when the NIF library is loaded.  Registers ResourceArc types.
fn on_load(env: Env, _info: rustler::Term) -> bool {
    rustler::resource!(ProjectEngineResource, env);
    rustler::resource!(SynthVoiceResource, env);
    true
}

//! Chunk mixing: query the interval tree, read mmap slices, apply track
//! parameters, produce a mixed wire frame.
//!
//! This is the hot path for timeline playback.  Called every 50 ms by the
//! Elixir pacing timer.  Must complete in well under 50 ms to avoid
//! buffer underruns.

use crate::dsp::fft::compute_fft_spectrum;
use crate::interface::FftBytes;
use crate::timeline::ProjectEngine;

/// Message type byte for mixer timeline frames.
pub const MSG_TYPE_MIXER: u8 = 1;

/// Mix a chunk of timeline audio and return a complete wire frame.
///
/// # Arguments
/// * `engine`      – the project engine (must be locked by caller).
/// * `start_ms`    – playhead position in milliseconds.
/// * `duration_ms` – chunk length in milliseconds (typically 50 or 200).
///
/// # Returns
/// A `Vec<u8>` wire frame:
/// ```text
/// byte 0:       MSG_TYPE_MIXER (1)
/// bytes 1-3:    zero padding
/// bytes 4-515:  FFT spectrum (512 bytes)
/// bytes 516+:   PCM f32 LE samples
/// ```
pub fn mix_chunk(engine: &ProjectEngine, start_ms: u64, duration_ms: u32) -> Vec<u8> {
    let sr = engine.sample_rate as u64;
    let n_samples = ((sr * duration_ms as u64) / 1000) as usize;
    let mut output = vec![0.0_f32; n_samples];

    let end_ms = start_ms + duration_ms as u64;

    // ── 1. Query interval tree for all overlapping clips ───────────────────
    for clip in engine.timeline.query_range(start_ms, end_ms) {
        let params = engine
            .params
            .get(&clip.track_id)
            .cloned()
            .unwrap_or_default();

        if params.muted {
            continue;
        }

        // ── 2. Calculate source sample offset ──────────────────────────────
        // How far into the source audio does this chunk start?
        let clip_local_ms = if start_ms > clip.start_ms {
            start_ms - clip.start_ms
        } else {
            0
        };
        let source_ms = clip.source_offset_ms + clip_local_ms;
        let source_sample = ((source_ms * sr) / 1000) as usize;

        // How many samples to read from this clip for this chunk?
        let clip_remaining_ms = if clip.end_ms > start_ms {
            clip.end_ms - start_ms
        } else {
            0
        };
        let clip_samples = ((clip_remaining_ms * sr) / 1000).min(n_samples as u64) as usize;

        // Offset into the output buffer where this clip's audio starts.
        let output_offset = if clip.start_ms > start_ms {
            (((clip.start_ms - start_ms) * sr) / 1000) as usize
        } else {
            0
        };

        // ── 3. Read from mmap store ────────────────────────────────────────
        let src = engine
            .store
            .slice(clip.track_id, source_sample, clip_samples);

        // ── 4. Volume-scaled additive mix ──────────────────────────────────
        for (i, &sample) in src.iter().enumerate() {
            let out_idx = output_offset + i;
            if out_idx < n_samples {
                output[out_idx] += sample * params.volume;
            }
        }
    }

    // ── 5. Soft limiter ────────────────────────────────────────────────────
    for sample in output.iter_mut() {
        if sample.abs() > 1.0 {
            *sample = sample.tanh();
        }
    }

    // ── 6. FFT + wire frame pack ───────────────────────────────────────────
    let fft: FftBytes = compute_fft_spectrum(&output);
    build_mixer_frame(&fft, &output)
}

/// Assemble a mixer wire frame with MSG_TYPE_MIXER (1).
fn build_mixer_frame(fft: &FftBytes, pcm: &[f32]) -> Vec<u8> {
    let capacity = 4 + 512 + pcm.len() * 4;
    let mut frame = Vec::with_capacity(capacity);

    frame.push(MSG_TYPE_MIXER);
    frame.push(0u8);
    frame.push(0u8);
    frame.push(0u8);

    frame.extend_from_slice(fft);

    for &sample in pcm {
        frame.extend_from_slice(&sample.to_le_bytes());
    }

    debug_assert_eq!(frame.len(), capacity);
    frame
}

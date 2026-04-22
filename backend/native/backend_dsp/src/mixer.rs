//! Voice mixing and limiting for polyphonic bar rendering.
//!
//! Takes multiple rendered voice PCM buffers (each with a start offset within
//! the bar) and produces a single mixed output with soft limiting.

use crate::dsp::fft::compute_fft_spectrum;
use crate::interface::build_synth_frame;

/// Mix multiple voice PCM buffers into a single output and build a wire frame.
///
/// # Arguments
/// * `voice_pcms`    – Slice of f32 PCM slices, one per rendered voice.
/// * `offsets`       – Start sample index for each voice within the bar buffer.
/// * `total_samples` – Total number of samples in the output bar.
///
/// # Returns
/// A complete binary wire frame (header + FFT + mixed PCM) ready for
/// WebSocket transmission.
pub fn mix_and_build_frame(
    voice_pcms: &[&[f32]],
    offsets: &[usize],
    total_samples: usize,
) -> Vec<u8> {
    let mut mixed = vec![0.0_f32; total_samples];

    // Additive mixing: sum each voice into the output buffer at its offset.
    for (pcm, &offset) in voice_pcms.iter().zip(offsets.iter()) {
        for (i, &sample) in pcm.iter().enumerate() {
            let pos = offset + i;
            if pos < total_samples {
                mixed[pos] += sample;
            }
        }
    }

    // Soft limiter: tanh keeps the signal smooth near ±1 without hard clipping.
    // Only apply when the signal exceeds ±1 to preserve dynamics on quieter passages.
    for sample in mixed.iter_mut() {
        if sample.abs() > 1.0 {
            *sample = sample.tanh();
        }
    }

    let fft = compute_fft_spectrum(&mixed);
    build_synth_frame(&fft, &mixed)
}

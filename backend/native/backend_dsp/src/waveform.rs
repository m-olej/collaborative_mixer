//! Waveform peak generation for timeline thumbnail display.
//!
//! Accepts raw PCM f32 audio data and divides it into `num_bins` segments,
//! computing the min and max amplitude per segment.  The result is returned
//! as a list of `(min, max)` tuples that the frontend renders as a mini
//! waveform inside timeline clips.

/// Compute waveform peaks from raw f32 PCM samples.
///
/// # Arguments
/// * `pcm` — slice of f32 PCM samples (range -1.0 to 1.0).
/// * `num_bins` — number of output bins (typically ~200 for thumbnails).
///
/// # Returns
/// A `Vec<(f32, f32)>` where each tuple is `(min, max)` for that bin.
pub fn compute_waveform_peaks(pcm: &[f32], num_bins: usize) -> Vec<(f32, f32)> {
    if pcm.is_empty() || num_bins == 0 {
        return vec![(0.0, 0.0); num_bins];
    }

    let samples_per_bin = pcm.len() as f64 / num_bins as f64;
    let mut peaks = Vec::with_capacity(num_bins);

    for i in 0..num_bins {
        let start = (i as f64 * samples_per_bin) as usize;
        let end = ((i + 1) as f64 * samples_per_bin) as usize;
        let end = end.min(pcm.len());

        if start >= end {
            peaks.push((0.0_f32, 0.0_f32));
            continue;
        }

        let mut min_val = f32::MAX;
        let mut max_val = f32::MIN;

        for &sample in &pcm[start..end] {
            if sample < min_val {
                min_val = sample;
            }
            if sample > max_val {
                max_val = sample;
            }
        }

        peaks.push((min_val, max_val));
    }

    peaks
}

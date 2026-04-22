//! FFT spectrum computation for the WebSocket canvas visualizer.
//!
//! # Role in the pipeline
//! After the synthesizer renders PCM samples, this module computes a
//! 512-point magnitude spectrum so the React canvas can draw a real-time
//! frequency analyser alongside the oscilloscope waveform.
//!
//! # Wire placement
//! The 512-byte array returned by `compute_fft_spectrum` maps directly to
//! bytes 4–515 of the binary WebSocket frame defined in AGENTS.md §5:
//!
//! ```text
//! byte 0:       message type
//! bytes 1-3:    padding
//! bytes 4-515:  FFT spectrum  ← this module fills these
//! bytes 516+:   PCM f32 LE
//! ```

use std::f32::consts::PI;

use rustfft::{num_complex::Complex, FftPlanner};

/// Number of FFT magnitude bins written into the wire frame.
/// Must equal `SPECTRUM_WIDTH` in the React frontend constants.
pub const FFT_SIZE: usize = 512;

/// Compute a 512-byte log-scaled magnitude spectrum from a PCM slice.
///
/// # Algorithm
/// 1. Take the first `FFT_SIZE` PCM samples; zero-pad if the slice is shorter.
/// 2. Apply a **Hann window** to reduce spectral leakage at frame boundaries.
/// 3. Run a forward FFT via `rustfft` (in-place, no extra allocation).
/// 4. Convert positive-frequency bin magnitudes to a dB scale.
/// 5. Map [−80 dB, 0 dB] → [0, 255] and store as bytes.
/// 6. Mirror the lower 256 bins into the upper 256 so the frontend canvas
///    receives a symmetric display without needing to know the Nyquist limit.
///
/// # Why log-scale?
/// Human hearing perceives loudness logarithmically.  Linear magnitude
/// would compress quiet content to invisibility.  A dBFS mapping makes
/// both soft and loud partials visible on the canvas simultaneously.
pub fn compute_fft_spectrum(pcm: &[f32]) -> [u8; FFT_SIZE] {
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);

    // Build the windowed complex input buffer.
    // Only the first FFT_SIZE samples are used; the rest of the PCM (which
    // may be up to 44 100 samples for a 1-second render) is not needed here.
    let mut buffer: Vec<Complex<f32>> = (0..FFT_SIZE)
        .map(|i| {
            let sample = pcm.get(i).copied().unwrap_or(0.0);
            // Hann window: w[i] = 0.5 * (1 − cos(2π · i / (N−1)))
            // Reduces spectral leakage from the sharp frame boundaries.
            let w = 0.5 * (1.0 - (2.0 * PI * i as f32 / (FFT_SIZE - 1) as f32).cos());
            Complex::new(sample * w, 0.0)
        })
        .collect();

    // In-place forward FFT — rustfft 6.x modifies the slice.
    fft.process(&mut buffer);

    // Normalization factor: keeps magnitudes in a consistent range
    // regardless of the number of non-zero samples in the window.
    let norm = 1.0 / (FFT_SIZE as f32).sqrt();

    // Only the first N/2 bins are unique for a real-valued input signal
    // (the upper half is the complex conjugate mirror of the lower half).
    let half = FFT_SIZE / 2;

    let mut out = [0u8; FFT_SIZE];
    for i in 0..half {
        let magnitude = buffer[i].norm() * norm;

        // dBFS-like mapping: log10(max(magnitude, ε)) × 20
        // The 1e-9 floor prevents log(0) → −∞.
        let db = 20.0 * magnitude.max(1e-9_f32).log10();

        // Map [−80 dB, 0 dB] → [0, 255] then clamp to the valid byte range.
        let byte = ((db + 80.0) * (255.0 / 80.0)).clamp(0.0, 255.0) as u8;

        // Lower half: direct
        out[i] = byte;
        // Upper half: symmetric mirror so the frontend canvas looks natural
        // (low frequencies in the centre, high frequencies at the edges).
        out[FFT_SIZE - 1 - i] = byte;
    }

    out
}

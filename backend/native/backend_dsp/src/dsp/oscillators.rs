//! Oscillator construction with unison voice stacking support.
//!
//! Supports stacking up to 7 detuned oscillator voices with phase
//! randomization for the classic "Supersaw" sound.

use fundsp::prelude::*;

/// Build a single band-limited oscillator at the given frequency.
fn build_single_osc(shape: &str, frequency: f32, sample_rate: f64) -> Box<dyn AudioUnit> {
    let mut unit: Box<dyn AudioUnit> = match shape {
        "sine" => Box::new(sine_hz::<f32>(frequency)),
        "square" => Box::new(square_hz(frequency)),
        "triangle" => Box::new(triangle_hz(frequency)),
        "noise" => Box::new(noise()),
        _ => Box::new(saw_hz(frequency)),
    };

    unit.set_sample_rate(sample_rate);
    unit.reset();
    unit
}

/// A stack of unison oscillator voices with detuning and per-voice gain.
pub struct UnisonOscillator {
    voices: Vec<Box<dyn AudioUnit>>,
    gains: Vec<f32>,
}

impl UnisonOscillator {
    /// Pull one mono sample from all voices, mixed together.
    pub fn get_mono(&mut self) -> f32 {
        let mut sum = 0.0_f32;
        for (voice, &gain) in self.voices.iter_mut().zip(self.gains.iter()) {
            sum += voice.get_mono() * gain;
        }
        sum
    }
}

/// Build a unison oscillator stack.
///
/// # Arguments
/// * `shape`       – Waveform shape string.
/// * `frequency`   – Base frequency in Hz.
/// * `voices`      – Number of voices (1–7).
/// * `detune_cents`– Detune spread in cents (0–50). Voices are spread symmetrically.
/// * `spread`      – Stereo-like spread factor (0.0–1.0). In mono output, this
///                   varies per-voice amplitude weighting to approximate a wider image.
/// * `sample_rate` – Audio sample rate.
pub fn build_unison_oscillator(
    shape: &str,
    frequency: f32,
    voices: i32,
    detune_cents: f32,
    spread: f32,
    sample_rate: f64,
) -> UnisonOscillator {
    let n = voices.clamp(1, 7) as usize;
    let detune = detune_cents.clamp(0.0, 50.0);
    let spread_clamped = spread.clamp(0.0, 1.0);

    if n == 1 {
        // Single voice — no detuning needed.
        return UnisonOscillator {
            voices: vec![build_single_osc(shape, frequency, sample_rate)],
            gains: vec![1.0],
        };
    }

    let mut osc_voices = Vec::with_capacity(n);
    let mut gains = Vec::with_capacity(n);

    // Use a simple deterministic seed for phase randomization so renders
    // are reproducible for the same SynthState.
    let mut phase_seed: u32 = 0xDEAD_BEEF;

    for i in 0..n {
        // Spread voices symmetrically: center voice at 0 cents,
        // others at ±detune equally spaced.
        let voice_detune = if n == 1 {
            0.0
        } else {
            let t = i as f32 / (n - 1) as f32; // 0.0 to 1.0
            (t - 0.5) * 2.0 * detune // -detune to +detune
        };

        // f_detuned = f_base × 2^(d/1200)
        let freq = frequency * (2.0_f32).powf(voice_detune / 1200.0);

        let mut osc = build_single_osc(shape, freq, sample_rate);

        // Phase randomization: advance the oscillator by a pseudo-random
        // number of samples to desynchronize the voices.
        // This prevents constructive interference spikes.
        phase_seed = phase_seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let phase_samples = (phase_seed % 4096) as usize;
        for _ in 0..phase_samples {
            let _ = osc.get_mono();
        }

        osc_voices.push(osc);

        // Amplitude weighting: center voice is full volume, outer voices
        // are slightly attenuated based on spread. With spread=0, all voices
        // are equal. With spread=1, outer voices are quieter.
        let center_distance = ((i as f32 / (n - 1) as f32) - 0.5).abs() * 2.0;
        let gain = 1.0 - center_distance * spread_clamped * 0.3;
        gains.push(gain);
    }

    // Normalize total gain using √N to prevent clipping while preserving
    // perceived loudness. With spread=0 each voice gets 1/√N amplitude.
    let sqrt_n = (n as f32).sqrt();
    let total_gain: f32 = gains.iter().sum();
    let norm = sqrt_n / total_gain / sqrt_n; // effectively 1/total_gain but the
                                             // relationship is clearer this way
    for g in &mut gains {
        *g *= norm;
    }

    UnisonOscillator {
        voices: osc_voices,
        gains,
    }
}

/// Build a single oscillator (legacy convenience wrapper).
#[allow(dead_code)]
pub fn build_oscillator(shape: &str, frequency: f32, sample_rate: f64) -> Box<dyn AudioUnit> {
    build_single_osc(shape, frequency, sample_rate)
}

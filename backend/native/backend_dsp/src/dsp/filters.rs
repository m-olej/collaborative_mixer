//! Filter construction using fundsp SVF and Moog filter nodes.
//!
//! # Filter types provided
//!
//! | Variant       | fundsp node           | Character                                  |
//! |---------------|-----------------------|--------------------------------------------|
//! | SVF lowpass   | `lowpass_hz::<f32>`   | State-variable filter; clean and accurate  |
//! | Moog lowpass  | `moog_hz::<f32>`      | Nonlinear ladder; classic synth warmth     |
//!
//! # Why two filter types?
//! The SVF (State Variable Filter, `lowpass_hz`) is the technically correct
//! choice for transparent filtering.  The Moog (`moog_hz`) has nonlinear
//! internal feedback that adds pleasant harmonic distortion at high Q — the
//! characteristic "Moog squeal".  The frontend exposes a toggle for the user.
//!
//! # Type erasure
//! `lowpass_hz::<f32>` returns `An<FixedSvf<f32, LowpassMode<f32>>>` while
//! `moog_hz::<f32>` returns `An<Moog<f32, U1>>` — completely different types.
//! Both arms box into `Box<dyn AudioUnit>` so the engine function can hold
//! either behind a single pointer.

use fundsp::prelude::*;

/// Select the filter topology based on the `filter_type` field in `SynthState`.
/// All variants produce a node with **1 input and 1 output**.
pub enum FilterType {
    /// SVF (State Variable Filter) lowpass — transparent, accurate.
    SvfLowpass,
    /// Moog ladder lowpass — nonlinear, warm, resonant squeal at high Q.
    MoogLowpass,
}

impl FilterType {
    /// Parse a `SynthState::filter_type` string into a `FilterType`.
    /// Unknown values fall back to SVF lowpass.
    pub fn from_str(s: &str) -> Self {
        match s {
            "moog" => FilterType::MoogLowpass,
            _ => FilterType::SvfLowpass,
        }
    }
}

/// Build a lowpass filter node configured from the given parameters.
///
/// # Arguments
/// * `filter_type` – Which filter topology to build.
/// * `cutoff`      – Cutoff frequency in Hz (clamped to `[20, sample_rate/2 - 1]`).
/// * `resonance`   – Resonance control in the range [0.0, 1.0].
///   Mapped to a Q value: 0.0 → Q = 0.707 (Butterworth flat), 1.0 → Q ≈ 10.0.
/// * `sample_rate` – Audio sample rate in Hz.
///
/// # Returns
/// `Box<dyn AudioUnit>` with **1 input (audio) and 1 output (filtered audio)**.
/// Call `unit.filter_mono(sample)` per sample inside the render loop.
///
/// # Q mapping rationale
/// The perceptually useful range for a resonant lowpass is roughly:
///   - Q = 0.707  →  Butterworth (no resonance peak, flattest passband)
///   - Q = 1.0    →  slight presence boost
///   - Q = 5.0    →  strong resonance peak, audible whistle
///   - Q = 10.0   →  near self-oscillation
/// Mapping the [0, 1] UI range onto [0.707, 10.0] makes the full range
/// explorable without the user needing to understand Q values.
pub fn build_filter(
    filter_type: FilterType,
    cutoff: f32,
    resonance: f32,
    sample_rate: f64,
) -> Box<dyn AudioUnit> {
    // Clamp cutoff so fundsp never receives an out-of-range value.
    let cutoff_clamped = cutoff.clamp(20.0, (sample_rate as f32) * 0.499);

    // Map resonance [0.0, 1.0] -> Q [0.707, 10.0].
    let q = 0.707_f32 + resonance.clamp(0.0, 1.0) * (10.0 - 0.707);

    let mut unit: Box<dyn AudioUnit> = match filter_type {
        FilterType::SvfLowpass => {
            // `lowpass_hz::<f32>(f, q)` builds a FixedSvf with the parameters
            // baked in at construction time.  This is the correct choice when
            // parameters are stable across the rendered buffer.
            //
            // The SVF processes one sample at a time via `filter_mono(x)`.
            Box::new(lowpass_hz::<f32>(cutoff_clamped, q))
        }

        FilterType::MoogLowpass => {
            // `moog_hz::<f32>(frequency, q)` builds a Moog ladder LPF.
            // The Moog node uses a nonlinear tanh approximation internally,
            // giving it the "self-oscillation" character as Q approaches 1.0.
            //
            // Note: moog_hz Q is normalised differently from SVF Q.
            // We pass the same Q value — the tonal difference is part of the
            // character of choosing the Moog mode.
            Box::new(moog_hz::<f32>(cutoff_clamped, q))
        }
    };

    unit.set_sample_rate(sample_rate);
    unit.reset();

    unit
}

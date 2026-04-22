//! Low-Frequency Oscillator (LFO) for parameter modulation.
//!
//! The LFO outputs a value in the range [-1.0, 1.0] at sub-audio rates.
//! It modulates synthesis parameters (cutoff, pitch, volume) rather than
//! producing audible sound directly.

use std::f32::consts::PI;

/// LFO modulation target parameter.
pub enum LfoTarget {
    Cutoff,
    Pitch,
    Volume,
}

impl LfoTarget {
    pub fn from_str(s: &str) -> Self {
        match s {
            "pitch" => Self::Pitch,
            "volume" => Self::Volume,
            _ => Self::Cutoff,
        }
    }
}

/// Sub-audio rate oscillator for parameter modulation.
pub struct Lfo {
    phase: f32,
    rate: f32,
    depth: f32,
    shape: LfoShape,
    sample_rate: f32,
}

enum LfoShape {
    Sine,
    Triangle,
    Square,
    Saw,
}

impl LfoShape {
    fn from_str(s: &str) -> Self {
        match s {
            "triangle" => Self::Triangle,
            "square" => Self::Square,
            "saw" => Self::Saw,
            _ => Self::Sine,
        }
    }

    /// Evaluate the LFO waveform at phase [0.0, 1.0) → output [-1.0, 1.0].
    fn eval(&self, phase: f32) -> f32 {
        match self {
            Self::Sine => (2.0 * PI * phase).sin(),
            Self::Triangle => {
                if phase < 0.25 {
                    phase * 4.0
                } else if phase < 0.75 {
                    2.0 - phase * 4.0
                } else {
                    phase * 4.0 - 4.0
                }
            }
            Self::Square => {
                if phase < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            }
            Self::Saw => 2.0 * phase - 1.0,
        }
    }
}

impl Lfo {
    /// Create a new LFO.
    ///
    /// * `rate`  – Oscillation rate in Hz (0.1–20.0).
    /// * `depth` – Modulation depth (0.0–1.0).
    /// * `shape` – Waveform shape string.
    /// * `sample_rate` – Audio sample rate.
    pub fn new(rate: f32, depth: f32, shape: &str, sample_rate: f32) -> Self {
        Self {
            phase: 0.0,
            rate: rate.clamp(0.1, 20.0),
            depth: depth.clamp(0.0, 1.0),
            shape: LfoShape::from_str(shape),
            sample_rate,
        }
    }

    /// Get the current LFO value in [-depth, +depth] and advance the phase.
    pub fn tick(&mut self) -> f32 {
        let value = self.shape.eval(self.phase) * self.depth;
        self.phase += self.rate / self.sample_rate;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        value
    }

    /// Whether this LFO has any effect (depth > 0).
    pub fn is_active(&self) -> bool {
        self.depth > 0.001
    }
}

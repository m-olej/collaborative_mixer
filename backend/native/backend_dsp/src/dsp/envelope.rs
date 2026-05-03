//! ADSR envelope generator for amplitude and filter modulation.
//!
//! Produces a normalised multiplier `[0.0, 1.0]` that shapes the audio
//! over time.  Two independent instances are used in the render pipeline:
//!
//! * **Amp envelope** – gates the audio amplitude (prevents clicks).
//! * **Filter envelope** – modulates the filter cutoff for timbral shaping.
//!
//! All time parameters are in **seconds** internally; the public API on
//! `SynthState` uses milliseconds — conversion happens in `engine.rs`.
//!
//! The envelope uses an exponential curve for Decay and Release stages
//! (more natural than linear) and a linear Attack ramp.

/// ADSR envelope phases.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    Attack,
    Decay,
    Sustain,
    Release,
    Off,
}

/// Block-rate ADSR envelope generator.
///
/// Call [`tick`] once per sample (or once per block and hold the value).
/// Call [`note_off`] when the key is released to enter the Release phase.
#[derive(Debug, Clone)]
pub struct Adsr {
    phase: Phase,
    /// Current envelope output level.
    level: f32,
    /// Level captured at the moment `note_off` is called.
    release_start_level: f32,

    // ── Time constants (in samples) ────────────────────────────────────
    attack_samples: f32,
    decay_samples: f32,
    sustain_level: f32,
    release_samples: f32,

    /// Elapsed samples in the current phase.
    phase_pos: f32,
}

impl Adsr {
    /// Create a new ADSR that starts in the Attack phase immediately.
    ///
    /// * `attack_s`  – attack time in seconds
    /// * `decay_s`   – decay time in seconds
    /// * `sustain`   – sustain level `[0.0, 1.0]`
    /// * `release_s` – release time in seconds
    /// * `sample_rate` – audio sample rate (e.g. 44100.0)
    pub fn new(
        attack_s: f32,
        decay_s: f32,
        sustain: f32,
        release_s: f32,
        sample_rate: f32,
    ) -> Self {
        Self {
            phase: Phase::Attack,
            level: 0.0,
            release_start_level: 0.0,
            attack_samples: (attack_s * sample_rate).max(1.0),
            decay_samples: (decay_s * sample_rate).max(1.0),
            sustain_level: sustain.clamp(0.0, 1.0),
            release_samples: (release_s * sample_rate).max(1.0),
            phase_pos: 0.0,
        }
    }

    /// Trigger the release phase (note-off event).
    pub fn note_off(&mut self) {
        if self.phase == Phase::Off {
            return;
        }
        self.release_start_level = self.level;
        self.phase = Phase::Release;
        self.phase_pos = 0.0;
    }

    /// Returns `true` when the envelope has finished (level ≈ 0 after release).
    pub fn is_done(&self) -> bool {
        self.phase == Phase::Off
    }

    /// Advance the envelope by one sample and return the current level.
    pub fn tick(&mut self) -> f32 {
        match self.phase {
            Phase::Attack => {
                // Linear ramp 0 → 1
                self.level = self.phase_pos / self.attack_samples;
                if self.level >= 1.0 {
                    self.level = 1.0;
                    self.phase = Phase::Decay;
                    self.phase_pos = 0.0;
                } else {
                    self.phase_pos += 1.0;
                }
            }
            Phase::Decay => {
                // Exponential decay 1 → sustain
                let t = self.phase_pos / self.decay_samples;
                if t >= 1.0 {
                    self.level = self.sustain_level;
                    self.phase = Phase::Sustain;
                } else {
                    // Exponential: level = sustain + (1 - sustain) * e^(-5t)
                    // The -5 constant gives a musically useful curve.
                    self.level = self.sustain_level + (1.0 - self.sustain_level) * (-5.0 * t).exp();
                    self.phase_pos += 1.0;
                }
            }
            Phase::Sustain => {
                self.level = self.sustain_level;
                // Stays here until note_off() is called.
            }
            Phase::Release => {
                let t = self.phase_pos / self.release_samples;
                if t >= 1.0 {
                    self.level = 0.0;
                    self.phase = Phase::Off;
                } else {
                    // Exponential release from captured level → 0
                    self.level = self.release_start_level * (-5.0 * t).exp();
                    self.phase_pos += 1.0;
                }
            }
            Phase::Off => {
                self.level = 0.0;
            }
        }

        self.level
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attack_reaches_one() {
        let mut env = Adsr::new(0.01, 0.1, 0.5, 0.1, 44100.0);
        // After attack_samples ticks the level should be ~1.0
        let attack_samples = (0.01 * 44100.0) as usize;
        for _ in 0..attack_samples {
            env.tick();
        }
        assert!((env.tick() - 1.0).abs() < 0.05);
    }

    #[test]
    fn release_reaches_zero() {
        let mut env = Adsr::new(0.001, 0.001, 0.8, 0.01, 44100.0);
        // Run through attack+decay quickly
        for _ in 0..2000 {
            env.tick();
        }
        env.note_off();
        let release_samples = (0.01 * 44100.0) as usize;
        for _ in 0..release_samples + 100 {
            env.tick();
        }
        assert!(env.is_done());
        assert!(env.tick() < 0.001);
    }
}

//! Effects processing: drive, distortion, chorus, reverb, and volume.

use fundsp::prelude::*;
use std::f32::consts::PI;

// ---------------------------------------------------------------------------
// Drive (pre-filter tanh saturation)
// ---------------------------------------------------------------------------

/// Build a soft-clip / overdrive node using fundsp's `Tanh` shaper.
pub fn build_drive_node(drive: f32, sample_rate: f64) -> Box<dyn AudioUnit> {
    let drive_clamped = drive.clamp(1.0, 20.0);
    let mut unit: Box<dyn AudioUnit> = Box::new(shape(Tanh(drive_clamped)));
    unit.set_sample_rate(sample_rate);
    unit.reset();
    unit
}

// ---------------------------------------------------------------------------
// Distortion (post-filter waveshaping)
// ---------------------------------------------------------------------------

/// Distortion mode applied after the filter stage.
pub enum DistortionType {
    Off,
    SoftClip,
    HardClip,
    Atan,
}

impl DistortionType {
    pub fn from_str(s: &str) -> Self {
        match s {
            "soft_clip" => Self::SoftClip,
            "hard_clip" => Self::HardClip,
            "atan" => Self::Atan,
            _ => Self::Off,
        }
    }
}

/// Apply distortion to a single sample.
pub fn apply_distortion(sample: f32, dtype: &DistortionType, amount: f32) -> f32 {
    let amt = amount.clamp(0.0, 1.0);
    if amt < 0.001 {
        return sample;
    }
    // Scale the drive factor from amount: 1.0 (clean) to 10.0 (heavy)
    let drive = 1.0 + amt * 9.0;
    let driven = sample * drive;

    match dtype {
        DistortionType::Off => sample,
        DistortionType::SoftClip => driven.tanh(),
        DistortionType::HardClip => driven.clamp(-1.0, 1.0),
        DistortionType::Atan => (driven).atan() * (2.0 / PI),
    }
}

// ---------------------------------------------------------------------------
// Chorus (modulated delay line)
// ---------------------------------------------------------------------------

/// Simple mono chorus effect using a circular delay buffer with LFO-modulated
/// read position.
pub struct Chorus {
    buffer: Vec<f32>,
    write_pos: usize,
    lfo_phase: f32,
    rate: f32,
    depth: f32,
    mix: f32,
    sample_rate: f32,
}

impl Chorus {
    /// Create a new chorus effect.
    ///
    /// * `rate`  – LFO rate in Hz (0.1–5.0).
    /// * `depth` – Delay modulation depth (0.0–1.0). Max delay ~10ms.
    /// * `mix`   – Dry/wet blend (0.0–1.0).
    /// * `sample_rate` – Audio sample rate.
    pub fn new(rate: f32, depth: f32, mix: f32, sample_rate: f32) -> Self {
        // Max delay buffer: 50ms at sample_rate
        let buf_len = (sample_rate * 0.05) as usize;
        Self {
            buffer: vec![0.0; buf_len],
            write_pos: 0,
            lfo_phase: 0.0,
            rate: rate.clamp(0.1, 5.0),
            depth: depth.clamp(0.0, 1.0),
            mix: mix.clamp(0.0, 1.0),
            sample_rate,
        }
    }

    /// Process one sample through the chorus.
    pub fn process(&mut self, input: f32) -> f32 {
        if self.mix < 0.001 || self.depth < 0.001 {
            return input;
        }

        let buf_len = self.buffer.len();

        // Write input into circular buffer
        self.buffer[self.write_pos] = input;
        self.write_pos = (self.write_pos + 1) % buf_len;

        // LFO: sinusoidal modulation of the delay time
        let lfo = (2.0 * PI * self.lfo_phase).sin();
        self.lfo_phase += self.rate / self.sample_rate;
        if self.lfo_phase >= 1.0 {
            self.lfo_phase -= 1.0;
        }

        // Delay time: 5ms base + depth-modulated 0–5ms
        let base_delay_samples = self.sample_rate * 0.005;
        let mod_delay_samples = self.sample_rate * 0.005 * self.depth;
        let delay_samples = base_delay_samples + lfo * mod_delay_samples;

        // Read from delay buffer with linear interpolation
        let read_pos = self.write_pos as f32 - delay_samples;
        let read_pos = if read_pos < 0.0 {
            read_pos + buf_len as f32
        } else {
            read_pos
        };

        let idx0 = read_pos.floor() as usize % buf_len;
        let idx1 = (idx0 + 1) % buf_len;
        let frac = read_pos.fract();
        let delayed = self.buffer[idx0] * (1.0 - frac) + self.buffer[idx1] * frac;

        // Mix dry and wet
        input * (1.0 - self.mix) + delayed * self.mix
    }
}

// ---------------------------------------------------------------------------
// Reverb (Feedback Delay Network)
// ---------------------------------------------------------------------------

/// Simple algorithmic reverb using a Feedback Delay Network (FDN) with 4
/// delay lines of prime-number lengths.
pub struct Reverb {
    delays: [Vec<f32>; 4],
    positions: [usize; 4],
    decay: f32,
    mix: f32,
}

/// Prime-number delay lengths in samples at 44100 Hz.
/// Chosen to avoid common-factor resonances.
const DELAY_LENGTHS: [usize; 4] = [1117, 1327, 1523, 1733];

impl Reverb {
    pub fn new(decay: f32, mix: f32) -> Self {
        let decay = decay.clamp(0.0, 0.95);
        let mix = mix.clamp(0.0, 1.0);

        Self {
            delays: [
                vec![0.0; DELAY_LENGTHS[0]],
                vec![0.0; DELAY_LENGTHS[1]],
                vec![0.0; DELAY_LENGTHS[2]],
                vec![0.0; DELAY_LENGTHS[3]],
            ],
            positions: [0; 4],
            decay,
            mix,
        }
    }

    pub fn process(&mut self, input: f32) -> f32 {
        if self.mix < 0.001 {
            return input;
        }

        // Read from all 4 delay lines
        let mut outputs = [0.0_f32; 4];
        for i in 0..4 {
            outputs[i] = self.delays[i][self.positions[i]];
        }

        // Hadamard-like mixing matrix (simplified: each output feeds into
        // the next delay line with decay, plus the input)
        let feedback = [
            input + self.decay * (outputs[0] + outputs[1] - outputs[2] - outputs[3]) * 0.25,
            input + self.decay * (outputs[0] - outputs[1] + outputs[2] - outputs[3]) * 0.25,
            input + self.decay * (outputs[0] - outputs[1] - outputs[2] + outputs[3]) * 0.25,
            input + self.decay * (-outputs[0] + outputs[1] + outputs[2] + outputs[3]) * 0.25,
        ];

        // Write feedback into delay lines and advance positions
        for i in 0..4 {
            // Apply soft saturation inside the feedback loop for analog warmth
            self.delays[i][self.positions[i]] = feedback[i].tanh();
            self.positions[i] = (self.positions[i] + 1) % DELAY_LENGTHS[i];
        }

        // Sum all delay outputs for the wet signal
        let wet = (outputs[0] + outputs[1] + outputs[2] + outputs[3]) * 0.25;

        input * (1.0 - self.mix) + wet * self.mix
    }
}

// ---------------------------------------------------------------------------
// Volume (final output gain)
// ---------------------------------------------------------------------------

pub fn build_volume_node(volume: f32, sample_rate: f64) -> Box<dyn AudioUnit> {
    let volume_clamped = volume.clamp(0.0, 1.0);
    let mut unit: Box<dyn AudioUnit> = Box::new(shape_fn(move |x: f32| x * volume_clamped));
    unit.set_sample_rate(sample_rate);
    unit.reset();
    unit
}

//! Synthesizer parameter types shared between Elixir and Rust via Rustler.
//!
//! # Elixir to Rust boundary
//!
//! `SynthState` derives `NifMap`, which instructs Rustler to automatically
//! decode a plain Elixir map (no __struct__ field) into this struct.
//! Every field name in the struct must match the atom key in the Elixir map
//! exactly - Rustler validates this at decode time and returns a BadArg
//! error if a required key is missing or has the wrong type.

use rustler::NifMap;

#[allow(dead_code)]
pub const SHAPE_SAW: &str = "saw";
#[allow(dead_code)]
pub const SHAPE_SINE: &str = "sine";
#[allow(dead_code)]
pub const SHAPE_SQUARE: &str = "square";
#[allow(dead_code)]
pub const SHAPE_TRIANGLE: &str = "triangle";
#[allow(dead_code)]
pub const SHAPE_NOISE: &str = "noise";

/// Complete parameter set that defines the synthesizer sound.
#[derive(Debug, Clone, NifMap)]
pub struct SynthState {
    // ── Oscillator ──────────────────────────────────────────────────────
    /// Waveform shape: "saw" | "sine" | "square" | "triangle" | "noise".
    pub osc_shape: String,
    /// Fundamental pitch in Hz (e.g. 440.0 = A4).
    pub frequency: f32,

    // ── Unison ──────────────────────────────────────────────────────────
    /// Number of stacked oscillator voices (1 = no unison, max 7).
    pub unison_voices: i32,
    /// Detune spread in cents (0–50). Voices are spread symmetrically.
    pub unison_detune: f32,
    /// Stereo-like spread 0.0–1.0 (mixed down to mono but affects
    /// per-voice amplitude weighting for a wider sound).
    pub unison_spread: f32,

    // ── Filter ──────────────────────────────────────────────────────────
    /// Low-pass filter cutoff frequency in Hz.
    pub cutoff: f32,
    /// Filter resonance / Q control (0.0–1.0).
    pub resonance: f32,
    /// Filter topology: "svf" | "moog" | "highpass" | "bandpass".
    pub filter_type: String,

    // ── Drive / Distortion ──────────────────────────────────────────────
    /// Pre-filter overdrive multiplier (1.0 = clean).
    pub drive: f32,
    /// Distortion type applied after filter: "off" | "soft_clip" | "hard_clip" | "atan".
    pub distortion_type: String,
    /// Distortion intensity (0.0–1.0).
    pub distortion_amount: f32,

    // ── LFO ─────────────────────────────────────────────────────────────
    /// LFO oscillation rate in Hz (0.1–20.0).
    pub lfo_rate: f32,
    /// LFO modulation depth (0.0–1.0).
    pub lfo_depth: f32,
    /// LFO waveform: "sine" | "triangle" | "square" | "saw".
    pub lfo_shape: String,
    /// LFO modulation target: "cutoff" | "pitch" | "volume".
    pub lfo_target: String,

    // ── Chorus ──────────────────────────────────────────────────────────
    /// Chorus LFO rate in Hz (0.1–5.0).
    pub chorus_rate: f32,
    /// Chorus delay depth (0.0–1.0).
    pub chorus_depth: f32,
    /// Chorus dry/wet mix (0.0–1.0).
    pub chorus_mix: f32,

    // ── Reverb ──────────────────────────────────────────────────────────
    /// Reverb decay factor (0.0–1.0).
    pub reverb_decay: f32,
    /// Reverb dry/wet mix (0.0–1.0).
    pub reverb_mix: f32,

    // ── Amp ─────────────────────────────────────────────────────────────
    /// Final output volume (0.0–1.0).
    pub volume: f32,

    // ── Amp Envelope (ADSR) ─────────────────────────────────────────────
    /// Attack time in milliseconds (0–5000).
    pub amp_attack_ms: f32,
    /// Decay time in milliseconds (0–5000).
    pub amp_decay_ms: f32,
    /// Sustain level (0.0–1.0).
    pub amp_sustain: f32,
    /// Release time in milliseconds (0–5000).
    pub amp_release_ms: f32,

    // ── Filter Envelope (ADSR) ──────────────────────────────────────────
    /// Attack time in milliseconds (0–5000).
    pub filter_attack_ms: f32,
    /// Decay time in milliseconds (0–5000).
    pub filter_decay_ms: f32,
    /// Sustain level (0.0–1.0).
    pub filter_sustain: f32,
    /// Release time in milliseconds (0–5000).
    pub filter_release_ms: f32,
    /// Filter envelope depth: how many Hz the envelope sweeps above base cutoff.
    pub filter_env_depth: f32,
}

impl Default for SynthState {
    fn default() -> Self {
        Self {
            osc_shape: SHAPE_SAW.to_string(),
            frequency: 440.0,
            unison_voices: 1,
            unison_detune: 0.0,
            unison_spread: 0.0,
            cutoff: 5000.0,
            resonance: 0.0,
            filter_type: "svf".to_string(),
            drive: 1.0,
            distortion_type: "off".to_string(),
            distortion_amount: 0.0,
            lfo_rate: 1.0,
            lfo_depth: 0.0,
            lfo_shape: "sine".to_string(),
            lfo_target: "cutoff".to_string(),
            chorus_rate: 0.5,
            chorus_depth: 0.0,
            chorus_mix: 0.0,
            reverb_decay: 0.3,
            reverb_mix: 0.0,
            volume: 0.8,
            // Amp envelope: fast attack, medium decay, full sustain, short release
            amp_attack_ms: 5.0,
            amp_decay_ms: 100.0,
            amp_sustain: 1.0,
            amp_release_ms: 200.0,
            // Filter envelope: off by default (depth = 0)
            filter_attack_ms: 10.0,
            filter_decay_ms: 300.0,
            filter_sustain: 0.0,
            filter_release_ms: 200.0,
            filter_env_depth: 0.0,
        }
    }
}

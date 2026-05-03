//! Stateful synthesizer voice with persistent DSP state across render calls.
//!
//! Unlike `engine::render()` which constructs all nodes fresh each call,
//! `SynthVoice` retains oscillator phase, envelope position, filter state,
//! and effects buffers between chunk renders.  This enables:
//!
//! * **True streaming** — render 50 ms chunks on each pacing tick.
//! * **Real note-off** — release triggered by actual key-up event.
//! * **Effects tails** — reverb/chorus ring out after envelope finishes.
//! * **Voice culling** — voice is done only when envelope AND effects
//!   output drop below silence threshold.
//!
//! Wrapped in `SynthVoiceResource(Mutex<SynthVoice>)` for `ResourceArc` sharing.

use std::sync::Mutex;

use crate::dsp::{
    effects::{apply_distortion, Chorus, DistortionType, Reverb},
    envelope::Adsr,
    fft::compute_fft_spectrum,
    filters::{build_filter, FilterType},
    lfo::{Lfo, LfoTarget},
    oscillators::{build_unison_oscillator, UnisonOscillator},
};
use crate::interface::{build_synth_frame, FftBytes};
use crate::state::SynthState;

use fundsp::prelude::AudioUnit;

/// Silence threshold for voice culling.
/// Voice is considered done when peak output stays below this for a full chunk.
const SILENCE_THRESHOLD: f32 = 0.00001;

/// Block size for filter/LFO updates (samples).
const BLOCK_SIZE: usize = 64;

/// Pre-allocated output buffer capacity (50 ms at 44100 Hz ≈ 2205 samples).
/// We allocate for up to 200 ms (burst) and reuse.
const MAX_CHUNK_SAMPLES: usize = 44_100 / 5; // 200ms = 8820 samples

/// Persistent synthesizer voice state.
pub struct SynthVoice {
    // ── Oscillator ──────────────────────────────────────────────────────
    osc: UnisonOscillator,

    // ── LFO ─────────────────────────────────────────────────────────────
    lfo: Lfo,
    lfo_target: LfoTarget,
    lfo_active: bool,
    lfo_value: f32,

    // ── Filter ──────────────────────────────────────────────────────────
    filter: Box<dyn AudioUnit>,
    filter_type_str: String,
    base_cutoff: f32,
    resonance: f32,

    // ── Distortion ──────────────────────────────────────────────────────
    distortion_type: DistortionType,
    distortion_amount: f32,
    drive_amount: f32,

    // ── Envelopes ───────────────────────────────────────────────────────
    amp_env: Adsr,
    filter_env: Adsr,
    filter_env_depth: f32,

    // ── Effects ─────────────────────────────────────────────────────────
    chorus: Chorus,
    reverb: Reverb,

    // ── Output ──────────────────────────────────────────────────────────
    master_volume: f32,
    sample_rate: f32,

    // ── Voice lifecycle ─────────────────────────────────────────────────
    /// Sample counter within the current block (for block-rate updates).
    block_pos: usize,
    /// Whether note_off has been triggered.
    released: bool,
    /// Voice is fully done (envelope off AND effects tail silent).
    done: bool,
    /// Pre-allocated output buffer to avoid allocation in render loop.
    out_buf: Vec<f32>,
}

impl SynthVoice {
    /// Create a new voice from synth parameters at the given frequency.
    pub fn new(state: &SynthState, frequency: f32, sample_rate: f32) -> Self {
        let sr = sample_rate as f64;

        let osc = build_unison_oscillator(
            &state.osc_shape,
            frequency,
            state.unison_voices,
            state.unison_detune,
            state.unison_spread,
            sr,
        );

        let lfo = Lfo::new(
            state.lfo_rate,
            state.lfo_depth,
            &state.lfo_shape,
            sample_rate,
        );
        let lfo_target = LfoTarget::from_str(&state.lfo_target);
        let lfo_active = lfo.is_active();

        let filter_topology = FilterType::from_str(&state.filter_type);
        let filter = build_filter(filter_topology, state.cutoff, state.resonance, sr);

        let distortion_type = DistortionType::from_str(&state.distortion_type);

        let amp_env = Adsr::new(
            state.amp_attack_ms / 1000.0,
            state.amp_decay_ms / 1000.0,
            state.amp_sustain,
            state.amp_release_ms / 1000.0,
            sample_rate,
        );
        let filter_env = Adsr::new(
            state.filter_attack_ms / 1000.0,
            state.filter_decay_ms / 1000.0,
            state.filter_sustain,
            state.filter_release_ms / 1000.0,
            sample_rate,
        );

        let chorus = Chorus::new(
            state.chorus_rate,
            state.chorus_depth,
            state.chorus_mix,
            sample_rate,
        );
        let reverb = Reverb::new(state.reverb_decay, state.reverb_mix);

        SynthVoice {
            osc,
            lfo,
            lfo_target,
            lfo_active,
            lfo_value: 0.0,
            filter,
            filter_type_str: state.filter_type.clone(),
            base_cutoff: state.cutoff,
            resonance: state.resonance,
            distortion_type,
            distortion_amount: state.distortion_amount,
            drive_amount: state.drive.clamp(1.0, 20.0),
            amp_env,
            filter_env,
            filter_env_depth: state.filter_env_depth,
            chorus,
            reverb,
            master_volume: state.volume,
            sample_rate,
            block_pos: 0,
            released: false,
            done: false,
            out_buf: Vec::with_capacity(MAX_CHUNK_SAMPLES),
        }
    }

    /// Trigger the release phase (key-up event).
    pub fn note_off(&mut self) {
        if !self.released {
            self.released = true;
            self.amp_env.note_off();
            self.filter_env.note_off();
        }
    }

    /// Returns true when the voice has finished and can be destroyed.
    ///
    /// A voice is done when:
    /// 1. The amplitude envelope has completed (is_done == true), AND
    /// 2. The effects tail (chorus + reverb) has decayed below SILENCE_THRESHOLD.
    pub fn is_done(&self) -> bool {
        self.done
    }

    /// Render `num_samples` of audio and return the PCM + FFT wire frame.
    ///
    /// This is the hot path. The output buffer is pre-allocated and reused.
    /// No allocations occur inside the sample loop.
    pub fn render_chunk(&mut self, num_samples: usize) -> Vec<u8> {
        let samples = num_samples.min(MAX_CHUNK_SAMPLES);

        // Reuse pre-allocated buffer.
        self.out_buf.clear();

        let sr = self.sample_rate as f64;
        let mut peak = 0.0_f32;

        for _ in 0..samples {
            // Block-rate updates (every BLOCK_SIZE samples).
            if self.block_pos % BLOCK_SIZE == 0 {
                if self.lfo_active {
                    self.lfo_value = self.lfo.tick();
                }

                // Filter cutoff modulation: base + LFO + filter envelope.
                let lfo_cutoff_mod = if self.lfo_active && self.lfo_target == LfoTarget::Cutoff {
                    self.lfo_value * 4000.0
                } else {
                    0.0
                };
                let env_cutoff_mod = self.filter_env.tick() * self.filter_env_depth;
                let mod_cutoff = (self.base_cutoff + lfo_cutoff_mod + env_cutoff_mod)
                    .clamp(20.0, (sr as f32) * 0.499);
                let ft = FilterType::from_str(&self.filter_type_str);
                self.filter = build_filter(ft, mod_cutoff, self.resonance, sr);
            }
            self.block_pos += 1;

            // Step 1: oscillator
            let raw = self.osc.get_mono();

            // Step 2: filter
            let filtered = self.filter.filter_mono(raw);

            // Step 3: drive (tanh saturation)
            let driven = (filtered * self.drive_amount).tanh();

            // Step 4: distortion
            let distorted = apply_distortion(driven, &self.distortion_type, self.distortion_amount);

            // Step 5: amplitude envelope
            let amp = self.amp_env.tick();
            let enveloped = distorted * amp;

            // Step 6: chorus
            let chorused = self.chorus.process(enveloped);

            // Step 7: reverb
            let reverbed = self.reverb.process(chorused);

            // Step 8: master volume (+ optional LFO volume modulation)
            let vol = if self.lfo_active && self.lfo_target == LfoTarget::Volume {
                (self.master_volume + self.lfo_value * 0.5).clamp(0.0, 1.0)
            } else {
                self.master_volume
            };
            let out = reverbed * vol;

            // Track peak for voice culling.
            let abs_out = out.abs();
            if abs_out > peak {
                peak = abs_out;
            }

            self.out_buf.push(out);
        }

        // Voice culling: done when envelope is off AND output is silent.
        if self.amp_env.is_done() && peak < SILENCE_THRESHOLD {
            self.done = true;
        }

        // Build wire frame (header + FFT + PCM).
        let fft_bytes = compute_fft_spectrum(&self.out_buf);
        build_synth_frame(&fft_bytes, &self.out_buf)
    }
}

// Safety: SynthVoice is only accessed through Mutex, so Send is sufficient.
// fundsp AudioUnit types are Send but not Sync; the Mutex provides Sync.
unsafe impl Send for SynthVoice {}

/// Wrapper for ResourceArc registration.
pub struct SynthVoiceResource(pub Mutex<SynthVoice>);

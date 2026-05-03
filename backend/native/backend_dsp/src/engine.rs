//! Synthesizer render orchestrator.
//!
//! Signal chain:
//! ```text
//!  Unison Oscillators (N detuned voices, √N gain staging)
//!         ↓
//!  Filter (SVF or Moog lowpass, modulated by LFO + Filter ADSR)
//!         ↓
//!  Drive (tanh saturation)
//!         ↓
//!  Distortion (soft clip / hard clip / atan)
//!         ↓
//!  ADSR Amplitude Envelope (prevents clicks, shapes dynamics)
//!         ↓
//!  Chorus (modulated delay line)
//!         ↓
//!  Reverb (feedback delay network)
//!         ↓
//!  Volume (linear gain)
//!         ↓
//!  FFT + wire frame
//! ```

use crate::dsp::{
    effects::{apply_distortion, Chorus, DistortionType, Reverb},
    envelope::Adsr,
    fft::compute_fft_spectrum,
    filters::{build_filter, FilterType},
    lfo::{Lfo, LfoTarget},
    oscillators::build_unison_oscillator,
};
use crate::interface::FftBytes;
use crate::state::SynthState;

/// Audio sample rate used for all rendering.
pub const SAMPLE_RATE: f32 = 44_100.0;

/// Render `duration_secs` of audio from `state` and return the wire frame.
///
/// All nodes are constructed fresh for each render call — the NIF is a pure
/// function. The same `SynthState` always produces the same audio.
pub fn render(state: &SynthState, sample_rate: f32, duration_secs: f32) -> (Vec<f32>, FftBytes) {
    let sr = sample_rate as f64;
    let total_samples = (sample_rate * duration_secs).ceil() as usize;

    // ── 1. Unison Oscillator Stack ─────────────────────────────────────────
    let mut osc = build_unison_oscillator(
        &state.osc_shape,
        state.frequency,
        state.unison_voices,
        state.unison_detune,
        state.unison_spread,
        sr,
    );

    // ── 2. LFO ─────────────────────────────────────────────────────────────
    let mut lfo = Lfo::new(
        state.lfo_rate,
        state.lfo_depth,
        &state.lfo_shape,
        sample_rate,
    );
    let lfo_target = LfoTarget::from_str(&state.lfo_target);
    let lfo_active = lfo.is_active();

    // ── 3. Filter ──────────────────────────────────────────────────────────
    let filter_topology = FilterType::from_str(&state.filter_type);
    let mut filter = build_filter(filter_topology, state.cutoff, state.resonance, sr);

    // ── 4. Distortion ──────────────────────────────────────────────────────
    let distortion_type = DistortionType::from_str(&state.distortion_type);
    let distortion_amount = state.distortion_amount;

    // ── 5. ADSR Envelopes ──────────────────────────────────────────────────
    let mut amp_env = Adsr::new(
        state.amp_attack_ms / 1000.0,
        state.amp_decay_ms / 1000.0,
        state.amp_sustain,
        state.amp_release_ms / 1000.0,
        sample_rate,
    );
    let mut filter_env = Adsr::new(
        state.filter_attack_ms / 1000.0,
        state.filter_decay_ms / 1000.0,
        state.filter_sustain,
        state.filter_release_ms / 1000.0,
        sample_rate,
    );
    let filter_env_depth = state.filter_env_depth;

    // Trigger note-off for the amp envelope near the end of the render
    // to allow the release tail. For bar renders the actual note_off is
    // computed by the caller (render_voice_pcm_with_release).
    let note_off_sample = total_samples.saturating_sub(
        (state.amp_release_ms / 1000.0 * sample_rate) as usize,
    );

    // ── 6. Chorus ──────────────────────────────────────────────────────────
    let mut chorus = Chorus::new(
        state.chorus_rate,
        state.chorus_depth,
        state.chorus_mix,
        sample_rate,
    );

    // ── 7. Reverb ──────────────────────────────────────────────────────────
    let mut reverb = Reverb::new(state.reverb_decay, state.reverb_mix);

    // ── Block-rate constants ───────────────────────────────────────────────
    const BLOCK_SIZE: usize = 64;
    let base_cutoff = state.cutoff;
    let master_volume = state.volume;
    let drive_amount = state.drive.clamp(1.0, 20.0);

    // ── Render loop ────────────────────────────────────────────────────────
    let mut pcm = Vec::with_capacity(total_samples);
    #[allow(unused_assignments)]
    let mut lfo_value = 0.0_f32;

    for i in 0..total_samples {
        // Note-off trigger for standalone renders.
        if i == note_off_sample {
            amp_env.note_off();
            filter_env.note_off();
        }

        // Block-rate LFO update
        if i % BLOCK_SIZE == 0 {
            if lfo_active {
                lfo_value = lfo.tick();
            }

            // Filter cutoff = base + LFO mod + envelope mod
            let lfo_cutoff_mod = if lfo_active && lfo_target == LfoTarget::Cutoff {
                lfo_value * 4000.0
            } else {
                0.0
            };
            let env_cutoff_mod = filter_env.tick() * filter_env_depth;
            let mod_cutoff =
                (base_cutoff + lfo_cutoff_mod + env_cutoff_mod).clamp(20.0, (sr as f32) * 0.499);
            let ft = FilterType::from_str(&state.filter_type);
            filter = build_filter(ft, mod_cutoff, state.resonance, sr);

            // Volume LFO (if targeting volume)
            if lfo_active && lfo_target == LfoTarget::Volume {
                // handled inline below
            }
        }

        // Step 1: oscillator (already gain-staged by √N inside build_unison_oscillator)
        let raw = osc.get_mono();

        // Step 2: filter
        let filtered = filter.filter_mono(raw);

        // Step 3: drive (tanh saturation)
        let driven = (filtered * drive_amount).tanh();

        // Step 4: distortion
        let distorted = apply_distortion(driven, &distortion_type, distortion_amount);

        // Step 5: amplitude envelope
        let amp = amp_env.tick();
        let enveloped = distorted * amp;

        // Step 6: chorus
        let chorused = chorus.process(enveloped);

        // Step 7: reverb
        let reverbed = reverb.process(chorused);

        // Step 8: master volume (+ optional LFO volume modulation)
        let vol = if lfo_active && lfo_target == LfoTarget::Volume {
            (master_volume + lfo_value * 0.5).clamp(0.0, 1.0)
        } else {
            master_volume
        };
        let out = reverbed * vol;

        pcm.push(out);
    }

    // ── FFT spectrum ───────────────────────────────────────────────────────
    let fft_bytes = compute_fft_spectrum(&pcm);

    (pcm, fft_bytes)
}

/// Render a single voice with explicit note-off timing for bar renders.
///
/// `note_duration_secs` controls when note-off fires; the total render
/// includes extra time for the release tail.
pub fn render_voice_with_release(
    state: &SynthState,
    sample_rate: f32,
    note_duration_secs: f32,
    release_secs: f32,
) -> Vec<f32> {
    let sr = sample_rate as f64;
    let total_duration = note_duration_secs + release_secs;
    let total_samples = (sample_rate * total_duration).ceil() as usize;
    let note_off_sample = (sample_rate * note_duration_secs).ceil() as usize;

    // ── Build all DSP nodes (same as render()) ─────────────────────────
    let mut osc = build_unison_oscillator(
        &state.osc_shape,
        state.frequency,
        state.unison_voices,
        state.unison_detune,
        state.unison_spread,
        sr,
    );

    let mut lfo = Lfo::new(state.lfo_rate, state.lfo_depth, &state.lfo_shape, sample_rate);
    let lfo_target = LfoTarget::from_str(&state.lfo_target);
    let lfo_active = lfo.is_active();

    let filter_topology = FilterType::from_str(&state.filter_type);
    let mut filter = build_filter(filter_topology, state.cutoff, state.resonance, sr);

    let distortion_type = DistortionType::from_str(&state.distortion_type);
    let distortion_amount = state.distortion_amount;

    let mut amp_env = Adsr::new(
        state.amp_attack_ms / 1000.0,
        state.amp_decay_ms / 1000.0,
        state.amp_sustain,
        state.amp_release_ms / 1000.0,
        sample_rate,
    );
    let mut filter_env = Adsr::new(
        state.filter_attack_ms / 1000.0,
        state.filter_decay_ms / 1000.0,
        state.filter_sustain,
        state.filter_release_ms / 1000.0,
        sample_rate,
    );
    let filter_env_depth = state.filter_env_depth;

    let mut chorus = Chorus::new(state.chorus_rate, state.chorus_depth, state.chorus_mix, sample_rate);
    let mut reverb = Reverb::new(state.reverb_decay, state.reverb_mix);

    const BLOCK_SIZE: usize = 64;
    let base_cutoff = state.cutoff;
    let master_volume = state.volume;
    let drive_amount = state.drive.clamp(1.0, 20.0);

    let mut pcm = Vec::with_capacity(total_samples);
    #[allow(unused_assignments)]
    let mut lfo_value = 0.0_f32;

    for i in 0..total_samples {
        if i == note_off_sample {
            amp_env.note_off();
            filter_env.note_off();
        }

        if i % BLOCK_SIZE == 0 {
            if lfo_active {
                lfo_value = lfo.tick();
            }
            let lfo_cutoff_mod = if lfo_active && lfo_target == LfoTarget::Cutoff {
                lfo_value * 4000.0
            } else {
                0.0
            };
            let env_cutoff_mod = filter_env.tick() * filter_env_depth;
            let mod_cutoff =
                (base_cutoff + lfo_cutoff_mod + env_cutoff_mod).clamp(20.0, (sr as f32) * 0.499);
            let ft = FilterType::from_str(&state.filter_type);
            filter = build_filter(ft, mod_cutoff, state.resonance, sr);
        }

        let raw = osc.get_mono();
        let filtered = filter.filter_mono(raw);
        let driven = (filtered * drive_amount).tanh();
        let distorted = apply_distortion(driven, &distortion_type, distortion_amount);
        let amp = amp_env.tick();
        let enveloped = distorted * amp;
        let chorused = chorus.process(enveloped);
        let reverbed = reverb.process(chorused);

        let vol = if lfo_active && lfo_target == LfoTarget::Volume {
            (master_volume + lfo_value * 0.5).clamp(0.0, 1.0)
        } else {
            master_volume
        };
        pcm.push(reverbed * vol);

        // Early exit: if envelope is done and reverb tail is negligible
        if amp_env.is_done() && i > note_off_sample + (sample_rate * 0.05) as usize {
            break;
        }
    }

    pcm
}

/// Render PCM audio only (no FFT computation).
///
/// Used by `render_voice_pcm` NIF for polyphonic bar rendering where FFT
/// is computed once on the final mixed output, not on individual voices.
pub fn render_pcm_only(state: &SynthState, sample_rate: f32, duration_secs: f32) -> Vec<f32> {
    let (pcm, _fft) = render(state, sample_rate, duration_secs);
    pcm
}

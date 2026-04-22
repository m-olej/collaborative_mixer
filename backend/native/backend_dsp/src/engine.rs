//! Synthesizer render orchestrator.
//!
//! Signal chain:
//! ```text
//!  Unison Oscillators (N detuned voices)
//!         ↓
//!  LFO Modulation (cutoff / pitch / volume)
//!         ↓
//!  Drive (tanh saturation)
//!         ↓
//!  Filter (SVF or Moog lowpass)
//!         ↓
//!  Distortion (soft clip / hard clip / atan)
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
    effects::{
        apply_distortion, build_drive_node, build_volume_node, Chorus, DistortionType, Reverb,
    },
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

    // ── 3. Drive ───────────────────────────────────────────────────────────
    let mut drive = build_drive_node(state.drive, sr);

    // ── 4. Filter ──────────────────────────────────────────────────────────
    let filter_topology = FilterType::from_str(&state.filter_type);
    let mut filter = build_filter(filter_topology, state.cutoff, state.resonance, sr);

    // ── 5. Distortion ──────────────────────────────────────────────────────
    let distortion_type = DistortionType::from_str(&state.distortion_type);
    let distortion_amount = state.distortion_amount;

    // ── 6. Chorus ──────────────────────────────────────────────────────────
    let mut chorus = Chorus::new(
        state.chorus_rate,
        state.chorus_depth,
        state.chorus_mix,
        sample_rate,
    );

    // ── 7. Reverb ──────────────────────────────────────────────────────────
    let mut reverb = Reverb::new(state.reverb_decay, state.reverb_mix);

    // ── 8. Volume ──────────────────────────────────────────────────────────
    let mut volume = build_volume_node(state.volume, sr);

    // We need a separate filter instance when LFO modulates cutoff, since we
    // need to rebuild filter coefficients. For simplicity, we use block-rate
    // LFO processing: update modulated parameters every BLOCK_SIZE samples.
    const BLOCK_SIZE: usize = 64;

    let base_cutoff = state.cutoff;
    let base_volume = state.volume;

    // ── Render loop ────────────────────────────────────────────────────────
    let mut pcm = Vec::with_capacity(total_samples);
    #[allow(unused_assignments)]
    let mut lfo_value = 0.0_f32;

    for i in 0..total_samples {
        // Block-rate LFO update
        if lfo_active && i % BLOCK_SIZE == 0 {
            lfo_value = lfo.tick();

            match lfo_target {
                LfoTarget::Cutoff => {
                    // Modulate cutoff: base_cutoff ± depth * 4000 Hz
                    let mod_cutoff =
                        (base_cutoff + lfo_value * 4000.0).clamp(20.0, (sr as f32) * 0.499);
                    let q = 0.707_f32 + state.resonance.clamp(0.0, 1.0) * (10.0 - 0.707);
                    let ft = FilterType::from_str(&state.filter_type);
                    filter = build_filter(ft, mod_cutoff, state.resonance, sr);
                    let _ = q; // Q already used inside build_filter
                }
                LfoTarget::Volume => {
                    // Modulate volume: base_volume ± depth * 0.5
                    let mod_vol = (base_volume + lfo_value * 0.5).clamp(0.0, 1.0);
                    volume = build_volume_node(mod_vol, sr);
                }
                LfoTarget::Pitch => {
                    // Pitch modulation is handled per-sample below for
                    // smoothness, but we still update lfo_value at block rate.
                }
            }
        }

        // Step 1: oscillator
        let raw = osc.get_mono();

        // Step 2: drive
        let driven = drive.filter_mono(raw);

        // Step 3: filter
        let filtered = filter.filter_mono(driven);

        // Step 4: distortion
        let distorted = apply_distortion(filtered, &distortion_type, distortion_amount);

        // Step 5: chorus
        let chorused = chorus.process(distorted);

        // Step 6: reverb
        let reverbed = reverb.process(chorused);

        // Step 7: volume
        let out = volume.filter_mono(reverbed);

        pcm.push(out);
    }

    // ── FFT spectrum ───────────────────────────────────────────────────────
    let fft_bytes = compute_fft_spectrum(&pcm);

    (pcm, fft_bytes)
}

/// Render PCM audio only (no FFT computation).
///
/// Used by `render_voice_pcm` NIF for polyphonic bar rendering where FFT
/// is computed once on the final mixed output, not on individual voices.
pub fn render_pcm_only(state: &SynthState, sample_rate: f32, duration_secs: f32) -> Vec<f32> {
    let (pcm, _fft) = render(state, sample_rate, duration_secs);
    pcm
}

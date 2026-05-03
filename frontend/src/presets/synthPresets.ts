import { type SynthParams, DEFAULT_SYNTH_PARAMS } from "../types/daw";

export interface SynthPreset {
  name: string;
  category: string;
  params: SynthParams;
}

/** Build a preset by merging overrides onto defaults. */
function preset(name: string, category: string, overrides: Partial<SynthParams>): SynthPreset {
  return { name, category, params: { ...DEFAULT_SYNTH_PARAMS, ...overrides } };
}

export const SYNTH_PRESETS: SynthPreset[] = [
  // ── Basses ────────────────────────────────────────────────────────────
  preset("808 Sub Bass", "Basses", {
    osc_shape: "sine",
    unison_voices: 1,
    unison_detune: 0,
    unison_spread: 0,
    amp_attack_ms: 10,
    amp_decay_ms: 1200,
    amp_sustain: 0.4,
    amp_release_ms: 1000,
    filter_type: "svf",
    cutoff: 150,
    resonance: 0,
    filter_env_depth: 0,
    filter_attack_ms: 10,
    filter_decay_ms: 300,
    filter_sustain: 0,
    filter_release_ms: 200,
    drive: 1.3,
    distortion_type: "soft_clip",
    distortion_amount: 0.3,
    chorus_mix: 0,
    reverb_mix: 0,
  }),

  preset("Dubstep Wub Bass", "Basses", {
    osc_shape: "saw",
    unison_voices: 3,
    unison_detune: 12,
    unison_spread: 0.5,
    amp_attack_ms: 10,
    amp_decay_ms: 500,
    amp_sustain: 1.0,
    amp_release_ms: 150,
    filter_type: "svf",
    cutoff: 80,
    resonance: 0.6,
    filter_env_depth: 0,
    lfo_target: "cutoff",
    lfo_shape: "triangle",
    lfo_rate: 3,
    lfo_depth: 0.8,
    drive: 1.0,
    distortion_type: "hard_clip",
    distortion_amount: 0.6,
    chorus_mix: 0.1,
    reverb_mix: 0,
  }),

  // ── Synths & Keys ────────────────────────────────────────────────────
  preset("Supersaw Chord", "Synths", {
    osc_shape: "saw",
    unison_voices: 7,
    unison_detune: 25,
    unison_spread: 1.0,
    amp_attack_ms: 15,
    amp_decay_ms: 1500,
    amp_sustain: 0.8,
    amp_release_ms: 400,
    filter_type: "svf",
    cutoff: 4500,
    resonance: 0.1,
    filter_attack_ms: 15,
    filter_decay_ms: 500,
    filter_sustain: 0,
    filter_release_ms: 200,
    filter_env_depth: 1600,
    drive: 1.0,
    distortion_type: "off",
    distortion_amount: 0,
    chorus_mix: 0.2,
    chorus_depth: 0.5,
    chorus_rate: 0.8,
    reverb_mix: 0.4,
    reverb_decay: 0.7,
  }),

  preset("Synth Pluck", "Synths", {
    osc_shape: "square",
    unison_voices: 1,
    unison_detune: 0,
    unison_spread: 0,
    amp_attack_ms: 0,
    amp_decay_ms: 800,
    amp_sustain: 0,
    amp_release_ms: 200,
    filter_type: "svf",
    cutoff: 200,
    resonance: 0.2,
    filter_attack_ms: 0,
    filter_decay_ms: 350,
    filter_sustain: 0,
    filter_release_ms: 200,
    filter_env_depth: 6400,
    drive: 1.0,
    distortion_type: "off",
    distortion_amount: 0,
    chorus_mix: 0,
    reverb_mix: 0.25,
    reverb_decay: 0.4,
  }),

  // ── Pads & Atmospheres ───────────────────────────────────────────────
  preset("Cinematic Pad", "Pads", {
    osc_shape: "saw",
    unison_voices: 5,
    unison_detune: 15,
    unison_spread: 0.8,
    amp_attack_ms: 1200,
    amp_decay_ms: 1000,
    amp_sustain: 0.9,
    amp_release_ms: 2500,
    filter_type: "svf",
    cutoff: 600,
    resonance: 0,
    filter_env_depth: 0,
    lfo_target: "cutoff",
    lfo_shape: "sine",
    lfo_rate: 0.1,
    lfo_depth: 0.15,
    drive: 1.0,
    distortion_type: "off",
    distortion_amount: 0,
    chorus_mix: 0.5,
    chorus_depth: 0.6,
    chorus_rate: 0.3,
    reverb_mix: 0.6,
    reverb_decay: 0.9,
  }),

  // ── Synthetic Drums ──────────────────────────────────────────────────
  preset("Closed Hi-Hat", "Drums", {
    osc_shape: "noise",
    unison_voices: 1,
    unison_detune: 0,
    unison_spread: 0,
    amp_attack_ms: 0,
    amp_decay_ms: 60,
    amp_sustain: 0,
    amp_release_ms: 40,
    filter_type: "highpass",
    cutoff: 7000,
    resonance: 0.3,
    filter_env_depth: 0,
    drive: 1.0,
    distortion_type: "off",
    distortion_amount: 0,
    chorus_mix: 0,
    reverb_mix: 0,
    lfo_depth: 0,
  }),

  preset("Synth Snare", "Drums", {
    osc_shape: "noise",
    unison_voices: 1,
    unison_detune: 0,
    unison_spread: 0,
    amp_attack_ms: 0,
    amp_decay_ms: 200,
    amp_sustain: 0,
    amp_release_ms: 100,
    filter_type: "bandpass",
    cutoff: 1500,
    resonance: 0.2,
    filter_env_depth: 0,
    drive: 1.0,
    distortion_type: "soft_clip",
    distortion_amount: 0.4,
    chorus_mix: 0,
    reverb_mix: 0,
    lfo_depth: 0,
  }),
];

/** Group presets by category for UI display. */
export function getPresetsByCategory(): Map<string, SynthPreset[]> {
  const map = new Map<string, SynthPreset[]>();
  for (const p of SYNTH_PRESETS) {
    const list = map.get(p.category) ?? [];
    list.push(p);
    map.set(p.category, list);
  }
  return map;
}

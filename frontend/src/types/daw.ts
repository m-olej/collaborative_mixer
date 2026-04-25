/** Shared TypeScript types for the Cloud DAW application. */

// --- REST API types ---

export interface Project {
  id: number;
  name: string;
  bpm: number;
  time_signature: string;
  count_in_note_value?: CountInNoteValue;
  inserted_at: string;
  updated_at: string;
}

export interface Track {
  id: number;
  name: string;
  s3_key: string;
  position_ms: number;
  lane_index: number;
  lock_version: number;
  project_id: number;
  inserted_at: string;
  updated_at: string;
}

export interface Sample {
  id: number;
  name: string;
  genre: string | null;
  s3_key: string;
  duration_ms: number | null;
  input_history: RecordedNote[] | null;
  bar_count: number;
  waveform_peaks: WaveformPeak[] | null;
  inserted_at: string;
}

export interface WaveformPeak {
  min: number;
  max: number;
}

export interface Export {
  id: number;
  token: string;
  status: "pending" | "completed" | "failed";
  project_id: number;
  inserted_at: string;
  updated_at: string;
}

// --- Paginated response ---

export interface PaginatedResponse<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
}

// --- WebSocket mixer state ---

export interface TrackMixerState {
  volume: number;
  muted: boolean;
  solo: boolean;
  pan: number;
  eq: EqSettings;
}

export interface EqSettings {
  low: number;
  mid: number;
  high: number;
}

export interface MixerState {
  project_id: number;
  tracks: Record<string, TrackMixerState>;
  master_volume: number;
  playing: boolean;
  playhead_ms: number;
}

// --- Binary frame ---

export interface AudioFrame {
  fft: Uint8Array;
  pcm: Float32Array;
}

/** Decode a binary WebSocket audio frame into FFT + PCM data. */
export function decodeAudioFrame(buffer: ArrayBuffer): AudioFrame {
  const fft = new Uint8Array(buffer, 4, 512);
  const pcm = new Float32Array(buffer, 516);
  return { fft, pcm };
}

// ---------------------------------------------------------------------------
// Synthesizer types
// ---------------------------------------------------------------------------

/** Waveform shapes supported by the Rust DSP engine. */
export type OscShape = "saw" | "sine" | "square" | "triangle";

/** Filter topology variants. */
export type FilterTypeVariant = "svf" | "moog";

/** LFO waveform shapes. */
export type LfoShape = "sine" | "triangle" | "square" | "saw";

/** LFO modulation target. */
export type LfoTarget = "cutoff" | "pitch" | "volume";

/** Distortion algorithm. */
export type DistortionType = "off" | "soft_clip" | "hard_clip" | "atan";

/**
 * All parameters that define the current synthesizer sound.
 * Field names match the Rust `SynthState` struct fields exactly.
 */
export interface SynthParams {
  // Oscillator
  osc_shape: OscShape;
  frequency: number;

  // Unison
  unison_voices: number;
  unison_detune: number;
  unison_spread: number;

  // Filter
  cutoff: number;
  resonance: number;
  filter_type: FilterTypeVariant;

  // Drive / Distortion
  drive: number;
  distortion_type: DistortionType;
  distortion_amount: number;

  // LFO
  lfo_rate: number;
  lfo_depth: number;
  lfo_shape: LfoShape;
  lfo_target: LfoTarget;

  // Chorus
  chorus_rate: number;
  chorus_depth: number;
  chorus_mix: number;

  // Reverb
  reverb_decay: number;
  reverb_mix: number;

  // Amp
  volume: number;
}

/** Default synth state matching the Rust `SynthState::default()`. */
export const DEFAULT_SYNTH_PARAMS: SynthParams = {
  osc_shape: "saw",
  frequency: 440,
  unison_voices: 1,
  unison_detune: 0,
  unison_spread: 0,
  cutoff: 5000,
  resonance: 0,
  filter_type: "svf",
  drive: 1,
  distortion_type: "off",
  distortion_amount: 0,
  lfo_rate: 1,
  lfo_depth: 0,
  lfo_shape: "sine",
  lfo_target: "cutoff",
  chorus_rate: 0.5,
  chorus_depth: 0,
  chorus_mix: 0,
  reverb_decay: 0.3,
  reverb_mix: 0,
  volume: 0.8,
};

// ---------------------------------------------------------------------------
// Recording / sample design types
// ---------------------------------------------------------------------------

/** Count-in note value determines metronome grid resolution. */
export type CountInNoteValue = "quarter" | "eighth" | "sixteenth";

/** A single note recorded during a bar. */
export interface RecordedNote {
  midi: number;
  note: string;
  frequency: number;
  /** Milliseconds from bar start. */
  start_ms: number;
  /** Milliseconds from bar start. Absent if note is still held. */
  end_ms: number;
}

/** State machine for the recording workflow. */
export type RecordingPhase = "idle" | "count-in" | "recording" | "rendering" | "done";

/** Local sample data stored during a design session. */
export interface LocalSample {
  inputHistory: RecordedNote[];
  /** PCM Float32Array extracted from the server's rendered bar. */
  pcm: Float32Array;
  /** FFT Uint8Array from the server's rendered bar. */
  fft: Uint8Array;
  /** Total duration of the recording in milliseconds (barDurationMs * barCount). */
  totalDurationMs: number;
  /** Number of bars recorded. */
  barCount: number;
}

// ---------------------------------------------------------------------------
// Bar duration helpers
// ---------------------------------------------------------------------------

/** Parse a time signature string like "4/4" into [numerator, denominator]. */
export function parseTimeSignature(ts: string): [number, number] {
  const parts = ts.split("/");
  const num = parseInt(parts[0], 10) || 4;
  const den = parseInt(parts[1], 10) || 4;
  return [num, den];
}

/** Calculate bar duration in milliseconds from BPM and time signature. */
export function barDurationMs(bpm: number, timeSignature: string): number {
  const [num, den] = parseTimeSignature(timeSignature);
  // A beat = 1 quarter note. Bar contains (num/den)*4 quarter notes.
  // Each quarter note = 60000/bpm ms.
  return (num / den) * 4 * (60000 / bpm);
}

/** Number of metronome clicks in one bar for a given count-in note value. */
export function clicksPerBar(
  timeSignature: string,
  countInNoteValue: CountInNoteValue,
): number {
  const [num, den] = parseTimeSignature(timeSignature);
  const barQuarterNotes = (num / den) * 4;
  const multiplier = countInNoteValue === "sixteenth" ? 4 : countInNoteValue === "eighth" ? 2 : 1;
  return Math.round(barQuarterNotes * multiplier);
}

// ---------------------------------------------------------------------------
// Collaboration types
// ---------------------------------------------------------------------------

export interface CollabUser {
  username: string;
  color: string;
}

export interface RemoteUser extends CollabUser {
  cursor: { x: number; y: number } | null;
  selection: CollabSelection | null;
}

export type CollabSelection =
  | { type: "timeline_clip"; id: number }
  | { type: "library_sample"; id: number };

// ---------------------------------------------------------------------------
// Timeline / snap types
// ---------------------------------------------------------------------------

export type SnapResolution = "bar" | "beat" | "1/8" | "1/16" | "free";

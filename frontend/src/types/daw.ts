/** Shared TypeScript types for the Cloud DAW application. */

// --- REST API types ---

export interface Project {
  id: number;
  name: string;
  bpm: number;
  time_signature: string;
  inserted_at: string;
  updated_at: string;
}

export interface Track {
  id: number;
  name: string;
  s3_key: string;
  position_ms: number;
  project_id: number;
}

export interface Sample {
  id: number;
  name: string;
  genre: string | null;
  s3_key: string;
  duration_ms: number | null;
  inserted_at: string;
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

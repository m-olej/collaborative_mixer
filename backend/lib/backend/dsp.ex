defmodule Backend.DSP do
  @moduledoc """
  NIF bridge to the Rust DSP engine (`native/backend_dsp`).

  Each function defined here is a stub.  At application start-up Rustler
  loads the compiled `.so` / `.dll` and replaces every stub body with the
  real NIF implementation.  If the NIF library fails to load the stubs
  raise `:nif_not_loaded` so the error is obvious rather than silent.

  ## Two independent pipelines

  ### Synthesizer (event-driven, stateless NIFs)
  * `render_synth/2`, `render_voice_pcm/2`, `mix_voices/3`
  * Each call is a pure function — same inputs always produce same audio.

  ### Timeline playback (stateful, ResourceArc-backed)
  * `init_engine/1` → creates a `ProjectEngine` (returned as opaque ref).
  * `decode_and_load_track/5` → decodes audio file, mmaps to SSD, inserts clip.
  * `rebuild_timeline/2` → atomically replaces the interval tree.
  * `set_track_params/2` → updates volumes/mutes/pans.
  * `mix_chunk/3` → queries interval tree, reads mmap, mixes, returns wire frame.

  ## NIF scheduling

  * `ping/0`, `generate_tone/3`, `init_engine/1`, `rebuild_timeline/2`,
    `set_track_params/2` — default scheduler (< 1 ms).
  * `render_synth/2`, `render_voice_pcm/2`, `mix_voices/3`,
    `generate_waveform_peaks/2`, `decode_and_load_track/5`, `mix_chunk/3`
    — **DirtyCpu** scheduler.
  """
  use Rustler, otp_app: :backend, crate: "backend_dsp"

  @doc "Health check — returns a greeting from the Rust engine."
  def ping, do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Generate a plain sine-wave tone (for testing/debugging).

  Returns a list of `f32` PCM samples (Erlang list, not binary).
  """
  def generate_tone(_frequency, _sample_rate, _duration_secs),
    do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Render a synthesized audio frame from the given parameter map.

  ## Arguments

  * `state` — plain Elixir map with **atom keys** matching `SynthState`:

      ```elixir
      %{
        osc_shape:   "saw",    # "saw" | "sine" | "square" | "triangle"
        frequency:   440.0,    # Hz
        cutoff:      2500.0,   # LPF cutoff Hz
        resonance:   0.7,      # 0.0–1.0  (Q control)
        drive:       1.2,      # overdrive multiplier
        volume:      0.8,      # 0.0–1.0
        filter_type: "svf"     # "svf" (default) | "moog"
      }
      ```

  * `duration_secs` — length of audio to render (float).  Recommended: 1.0.

  ## Returns

  An Erlang **binary** with the complete WebSocket wire frame:

  ```
  byte 0:       message type = 2
  bytes 1-3:    zero padding
  bytes 4-515:  FFT magnitude spectrum (512 bytes, 0–255 per bin)
  bytes 516+:   PCM f32 samples, little-endian
  ```

  The binary is allocated on the Erlang heap inside the NIF via
  `enif_alloc_binary`, so the Phoenix Channel can push it directly to the
  WebSocket without a second copy.
  """
  def render_synth(_state, _duration_secs), do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Render a single synthesizer voice as raw PCM for polyphonic bar rendering.

  Returns a binary containing f32 little-endian PCM samples (no header, no FFT).
  Used by `ProjectSession.render_bar/3` which spawns one Task per voice and
  calls this NIF concurrently.

  Marked `DirtyCpu` in Rust — safe to call from concurrent Tasks.
  """
  def render_voice_pcm(_state, _duration_secs), do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Mix multiple rendered voice PCM buffers into a single wire frame.

  ## Arguments

  * `pcm_binaries`  – list of binaries, each from `render_voice_pcm/2`.
  * `offsets`        – list of integers, start sample index for each voice.
  * `total_samples`  – total number of samples in the output bar buffer.

  ## Returns

  A binary wire frame (header + FFT + mixed PCM) ready for WebSocket push.
  """
  def mix_voices(_pcm_binaries, _offsets, _total_samples),
    do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Generate waveform peaks from raw PCM audio data for timeline thumbnails.

  ## Arguments

  * `audio_binary` — binary containing f32 little-endian PCM samples.
  * `num_bins`     — number of output bins (typically ~200).

  ## Returns

  A list of `{min, max}` tuples representing the amplitude range per bin.
  Marked `DirtyCpu` in Rust — may process large audio files.
  """
  def generate_waveform_peaks(_audio_binary, _num_bins),
    do: :erlang.nif_error(:nif_not_loaded)

  # ===========================================================================
  # Streaming voice NIFs — stateful ResourceArc-backed synth voices
  # ===========================================================================

  @doc """
  Create a new SynthVoice for streaming note preview.

  Returns an opaque ResourceArc holding persistent DSP state (oscillators,
  envelopes, filters, effects).  The voice starts in the Attack phase.

  ## Arguments
  * `state`     — synth parameter map (same as `render_synth/2`).
  * `frequency` — note frequency in Hz.
  """
  def create_synth_voice(_state, _frequency), do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Render the next chunk of audio from a persistent voice.

  Returns a binary wire frame (header + FFT + PCM) ready for WebSocket push.
  The voice state advances — subsequent calls continue from where the last
  chunk left off.

  ## Arguments
  * `voice`       — opaque ResourceArc from `create_synth_voice/2`.
  * `num_samples` — number of samples to render (e.g. 2205 for 50 ms).
  """
  def render_voice_chunk(_voice, _num_samples), do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Trigger the release phase on a voice (key-up event).

  The voice continues rendering the ADSR release tail and effects decay.
  Call `voice_is_done/1` to check when the voice can be destroyed.
  """
  def voice_note_off(_voice), do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Check if a voice has finished (envelope done AND effects tail silent).

  Returns `true` when the voice can be safely destroyed.
  """
  def voice_is_done(_voice), do: :erlang.nif_error(:nif_not_loaded)

  # ===========================================================================
  # Timeline playback NIFs — stateful ResourceArc-backed engine
  # ===========================================================================

  @doc """
  Create a new ProjectEngine for timeline playback.

  Returns an opaque reference (ResourceArc) that must be passed to all
  subsequent timeline NIFs.  The engine starts empty — tracks are loaded
  via `decode_and_load_track/5`.

  Default sample rate: 48 000 Hz.
  """
  def init_engine(_project_id), do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Decode raw audio bytes (WAV/MP3/FLAC from S3) and load into the engine.

  Decodes to mono f32 PCM at the engine's sample rate (48 kHz), writes to
  a tempfile on SSD, memory-maps it, and inserts a clip into the interval tree.

  ## Arguments
  * `engine`           – opaque ResourceArc from `init_engine/1`.
  * `track_id`         – integer DB track ID.
  * `audio_bytes`      – raw file bytes (binary from S3).
  * `clip_start_ms`    – global timeline position in milliseconds.
  * `source_offset_ms` – offset into the decoded audio (usually 0).

  Marked DirtyCpu — decoding can take hundreds of milliseconds.
  """
  def decode_and_load_track(_engine, _track_id, _audio_bytes, _clip_start_ms, _source_offset_ms),
    do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Atomically replace the entire timeline interval tree.

  Called after track create/move/delete to sync the Rust tree with the DB.

  ## Arguments
  * `engine` – opaque ResourceArc from `init_engine/1`.
  * `clips`  – list of maps: `%{clip_id: u64, track_id: u64, start_ms: u64, end_ms: u64, source_offset_ms: u64}`.
  """
  def rebuild_timeline(_engine, _clips), do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Update per-track mixing parameters (volume, mute, pan).

  Called on every slider_update event.  Fast path — no DirtyCpu.

  ## Arguments
  * `engine` – opaque ResourceArc from `init_engine/1`.
  * `params` – list of maps: `%{track_id: u64, volume: f32, muted: bool, pan: f32}`.
  """
  def set_track_params(_engine, _params), do: :erlang.nif_error(:nif_not_loaded)

  @doc """
  Mix a chunk of timeline audio at the given playhead position.

  Queries the interval tree for overlapping clips, reads audio from
  memory-mapped files, applies volume/mute, mixes, computes FFT,
  and returns a complete wire frame (type byte 1).

  ## Arguments
  * `engine`      – opaque ResourceArc from `init_engine/1`.
  * `start_ms`    – playhead position in milliseconds.
  * `duration_ms` – chunk length (50 for paced push, 200 for pre-roll burst).

  ## Returns
  Binary wire frame:
  ```
  byte 0:       message type = 1 (mixer)
  bytes 1-3:    zero padding
  bytes 4-515:  FFT magnitude spectrum (512 bytes)
  bytes 516+:   PCM f32 LE samples
  ```

  Marked DirtyCpu — mixing many overlapping clips can take several ms.
  """
  def mix_chunk(_engine, _start_ms, _duration_ms), do: :erlang.nif_error(:nif_not_loaded)
end

defmodule Backend.DSP do
  @moduledoc """
  NIF bridge to the Rust DSP engine (`native/backend_dsp`).

  Each function defined here is a stub.  At application start-up Rustler
  loads the compiled `.so` / `.dll` and replaces every stub body with the
  real NIF implementation.  If the NIF library fails to load the stubs
  raise `:nif_not_loaded` so the error is obvious rather than silent.

  ## NIF scheduling

  * `ping/0`, `generate_tone/3` — default scheduler (complete in < 1 ms).
  * `render_synth/2` — **DirtyCpu** scheduler (may run for tens of ms).
    Marked in the Rust source with `#[rustler::nif(schedule = "DirtyCpu")]`.
    This keeps the BEAM's regular scheduler threads free while Rust renders.
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
  Used by `SessionServer.render_bar/3` which spawns one Task per voice and
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
end

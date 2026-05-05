defmodule Backend.DawSession.VoiceStreamer do
  @moduledoc """
  Per-voice streaming process for note preview audio delivery.

  Each active note spawns one VoiceStreamer.  The process owns a Rust
  `SynthVoiceResource` (ResourceArc) and drives the burst & pace protocol:

  1. **Burst** — render 200 ms (8820 samples) immediately and send to channel.
  2. **Pace**  — every 50 ms, render 50 ms (2205 samples) and send to channel.
  3. **Release** — on `:note_off`, trigger the ADSR release phase.
  4. **Cull**  — after release, check `voice_is_done` each tick; terminate when true.

  The process sends `{:voice_audio, midi, binary}` messages to the channel pid.
  On termination it sends `{:voice_done, midi}` so the channel can clean up.
  """
  use GenServer, restart: :temporary

  alias Backend.DSP

  @sample_rate 44_100
  @burst_ms 100
  @pace_ms 50
  @burst_samples div(@sample_rate * @burst_ms, 1000)
  @pace_samples div(@sample_rate * @pace_ms, 1000)

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Start a voice streamer for a note.

  ## Arguments
  * `channel_pid`  — the channel process to send audio frames to.
  * `midi`         — MIDI note number (used as voice identifier).
  * `synth_params` — Elixir map of synth parameters (atom keys).
  * `frequency`    — note frequency in Hz.
  """
  def start_link({channel_pid, midi, synth_params, frequency}) do
    GenServer.start_link(__MODULE__, {channel_pid, midi, synth_params, frequency})
  end

  @doc "Trigger the release phase (key-up)."
  def note_off(pid) do
    GenServer.cast(pid, :note_off)
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init({channel_pid, midi, synth_params, frequency}) do
    # Create the Rust voice resource.
    voice = DSP.create_synth_voice(synth_params, frequency)

    state = %{
      channel_pid: channel_pid,
      midi: midi,
      voice: voice,
      timer_ref: nil
    }

    # Burst: render 200 ms immediately.
    burst_frame = DSP.render_voice_chunk(voice, @burst_samples)
    send(channel_pid, {:voice_audio, midi, burst_frame})

    # Start paced ticks.
    {:ok, timer_ref} = :timer.send_interval(@pace_ms, self(), :tick)

    {:ok, %{state | timer_ref: timer_ref}}
  end

  @impl true
  def handle_cast(:note_off, state) do
    DSP.voice_note_off(state.voice)
    {:noreply, state}
  end

  @impl true
  def handle_info(:tick, state) do
    # Render next chunk.
    frame = DSP.render_voice_chunk(state.voice, @pace_samples)
    send(state.channel_pid, {:voice_audio, state.midi, frame})

    # Check if voice is done (envelope finished + effects tail silent).
    if DSP.voice_is_done(state.voice) do
      cancel_timer(state)
      send(state.channel_pid, {:voice_done, state.midi})
      {:stop, :normal, state}
    else
      {:noreply, state}
    end
  end

  @impl true
  def terminate(_reason, state) do
    cancel_timer(state)
    :ok
  end

  # ---------------------------------------------------------------------------
  # Private
  # ---------------------------------------------------------------------------

  defp cancel_timer(%{timer_ref: nil}), do: :ok

  defp cancel_timer(%{timer_ref: ref}) do
    :timer.cancel(ref)
    :ok
  end
end

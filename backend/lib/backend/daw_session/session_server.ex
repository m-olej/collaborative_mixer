defmodule Backend.DawSession.SessionServer do
  @moduledoc """
  GenServer holding the live mixer **and synthesizer** state for a single
  project session.

  This process is the server-authoritative source of truth for all real-time
  parameters.  State is volatile (RAM only) — it is never auto-persisted to
  the database; the client must trigger an explicit save action via REST.

  ## Synthesizer data flow

  1. The React UI sends a `patch_update` JSON event over the Phoenix Channel.
  2. `ProjectChannel.handle_in/3` calls `patch_and_render/2` (a synchronous
     `GenServer.call`).
  3. This GenServer merges the incoming parameters into its `synth_params` map,
     then calls the Rust NIF `Backend.DSP.render_synth/2`.
  4. The NIF runs on a **DirtyCpu** thread and returns a binary wire frame.
  5. The binary is returned to the channel, which pushes it to the socket.

  ## Why GenServer.call for render?

  `call/3` (synchronous) is used rather than `cast/3` because the channel needs
  the rendered binary to push back on the *same* socket that initiated the event.
  The NIF is non-blocking from the BEAM scheduler's perspective (DirtyCpu), so
  the GenServer process itself will be blocked but no scheduler starvation occurs.
  """
  use GenServer

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  def start_link(project_id) do
    GenServer.start_link(__MODULE__, project_id, name: via(project_id))
  end

  @doc "Ensure a session process is running for the given project."
  def ensure_started(project_id) do
    case GenServer.whereis(via(project_id)) do
      nil -> Backend.DawSession.SessionSupervisor.start_session(project_id)
      pid -> {:ok, pid}
    end
  end

  @doc "Get the full mixer + synth state snapshot (used on channel join)."
  def get_state(project_id) do
    GenServer.call(via(project_id), :get_state)
  end

  @doc "Apply a mixer slider/parameter update from a client."
  def update_slider(project_id, params) do
    GenServer.cast(via(project_id), {:update_slider, params})
  end

  @doc "Get the current synthesizer parameters (used for save_sample)."
  def get_synth_params(project_id) do
    GenServer.call(via(project_id), :get_synth_params)
  end

  @doc """
  Render a polyphonic bar from a list of note events.

  Each note is rendered as a separate voice in a concurrent Task, then all
  voices are mixed into a single output via the `mix_voices` NIF.

  ## Arguments
  * `project_id`       – integer project ID.
  * `notes`            – list of maps: `%{"frequency" => f, "start_ms" => s, "end_ms" => e}`.
  * `bar_duration_ms`  – total bar length in milliseconds.

  ## Returns
  * `{:ok, binary}` on success (wire frame with header + FFT + mixed PCM).
  * `{:error, reason}` on failure.
  """
  def render_bar(project_id, notes, bar_duration_ms) do
    GenServer.call(via(project_id), {:render_bar, notes, bar_duration_ms}, :infinity)
  end

  @doc """
  Render a short note preview (for keyboard polyphonic preview).

  Uses a cast + reply-via-pid pattern so the GenServer is not blocked while
  the DirtyCpu NIF runs.  This allows multiple concurrent note previews
  without serialising them through the GenServer.
  """
  def render_note_preview(project_id, frequency, duration_secs, midi, reply_pid) do
    GenServer.cast(
      via(project_id),
      {:render_note_preview, frequency, duration_secs, midi, reply_pid}
    )
  end

  @doc """
  Merge synth parameters into the session state, call the Rust DSP NIF, and
  return the rendered binary wire frame.

  ## Arguments
  * `project_id` – integer project ID used to locate the session process.
  * `raw_params` – map from the channel payload (string keys from JSON).

  ## Returns
  * `{:ok, binary}` on success.
  * `{:error, reason}` if the NIF call raises.
  """
  def patch_and_render(project_id, raw_params) do
    GenServer.call(via(project_id), {:patch_and_render, raw_params}, :infinity)
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(project_id) do
    state = %{
      project_id: project_id,
      # Mixer state (existing)
      tracks: %{},
      master_volume: 1.0,
      playing: false,
      playhead_ms: 0,
      # Synthesizer state — atom-keyed so the map passes directly to the NIF
      synth_params: default_synth_params(),
      # Last bar render result (kept for save_sample)
      last_bar_render: nil,
      last_bar_duration_ms: nil,
      last_bar_notes: nil
    }

    {:ok, state}
  end

  @impl true
  def handle_call(:get_state, _from, state) do
    {:reply, serialize_state(state), state}
  end

  @impl true
  def handle_call(:get_synth_params, _from, state) do
    {:reply, state.synth_params, state}
  end

  @impl true
  def handle_call({:patch_and_render, raw_params}, _from, state) do
    # Merge incoming string-keyed params into the atom-keyed synth_params map.
    # We convert keys and validate values here rather than inside the NIF so
    # the Rust function receives a well-typed struct with no surprises.
    new_synth_params = merge_synth_params(state.synth_params, raw_params)
    new_state = %{state | synth_params: new_synth_params}

    # Call the Rust NIF on a DirtyCpu thread.
    # `render_synth/2` returns a binary wire frame or raises on error.
    result =
      try do
        binary = Backend.DSP.render_synth(new_synth_params, 1.0)
        {:ok, binary}
      rescue
        e -> {:error, Exception.message(e)}
      end

    {:reply, result, new_state}
  end

  @impl true
  def handle_call({:render_bar, notes, bar_duration_ms}, _from, state) do
    sample_rate = 44_100
    bar_duration_secs = bar_duration_ms / 1000.0
    total_samples = round(sample_rate * bar_duration_secs)

    # Spawn one Task per note, each rendering a single voice via the DirtyCpu NIF.
    # Elixir's Task module leverages BEAM schedulers; each NIF call runs on a
    # separate DirtyCpu thread, so voices are rendered truly in parallel.
    tasks =
      Enum.map(notes, fn note ->
        Task.async(fn ->
          freq = to_float(note["frequency"], 440.0)
          start_ms = to_float(note["start_ms"], 0.0)
          end_ms = to_float(note["end_ms"], bar_duration_ms / 1.0)
          duration_secs = max((end_ms - start_ms) / 1000.0, 0.01)
          start_sample = round(start_ms / 1000.0 * sample_rate)

          voice_params = %{state.synth_params | frequency: freq}
          pcm_binary = Backend.DSP.render_voice_pcm(voice_params, duration_secs)

          {pcm_binary, start_sample}
        end)
      end)

    # Await all voice renders (no timeout — DirtyCpu NIFs are bounded).
    results = Task.await_many(tasks, :infinity)
    {pcm_list, offsets} = Enum.unzip(results)

    # Mix all voices into a single output buffer and build the wire frame.
    result =
      try do
        binary = Backend.DSP.mix_voices(pcm_list, offsets, total_samples)
        {:ok, binary}
      rescue
        e -> {:error, Exception.message(e)}
      end

    # Store the last render for potential save_sample.
    new_state =
      case result do
        {:ok, _binary} ->
          %{
            state
            | last_bar_render: result,
              last_bar_duration_ms: bar_duration_ms,
              last_bar_notes: notes
          }

        _ ->
          state
      end

    {:reply, result, new_state}
  end

  @impl true
  def handle_cast({:update_slider, params}, state) do
    state = apply_slider_update(state, params)
    {:noreply, state}
  end

  @impl true
  def handle_cast({:render_note_preview, frequency, duration_secs, midi, reply_pid}, state) do
    # Spawn a Task to render the note without blocking the GenServer.
    # This allows multiple simultaneous note previews (polyphony).
    voice_params = %{state.synth_params | frequency: frequency}

    Task.start(fn ->
      try do
        binary = Backend.DSP.render_synth(voice_params, duration_secs)
        send(reply_pid, {:note_audio, midi, binary})
      rescue
        _ -> :ok
      end
    end)

    {:noreply, state}
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  defp via(project_id) do
    {:via, Registry, {Backend.SessionRegistry, project_id}}
  end

  # Merge string-keyed JSON params into the atom-keyed synth_params map.
  # Only known keys are accepted; unknown keys are silently ignored to prevent
  # atom-table pollution (never use String.to_atom/1 on user-supplied keys).
  defp merge_synth_params(current, raw) do
    %{
      osc_shape: Map.get(raw, "osc_shape", current.osc_shape),
      frequency: to_float(Map.get(raw, "frequency"), current.frequency),
      unison_voices: to_int(Map.get(raw, "unison_voices"), current.unison_voices),
      unison_detune: to_float(Map.get(raw, "unison_detune"), current.unison_detune),
      unison_spread: to_float(Map.get(raw, "unison_spread"), current.unison_spread),
      cutoff: to_float(Map.get(raw, "cutoff"), current.cutoff),
      resonance: to_float(Map.get(raw, "resonance"), current.resonance),
      filter_type: Map.get(raw, "filter_type", current.filter_type),
      drive: to_float(Map.get(raw, "drive"), current.drive),
      distortion_type: Map.get(raw, "distortion_type", current.distortion_type),
      distortion_amount: to_float(Map.get(raw, "distortion_amount"), current.distortion_amount),
      lfo_rate: to_float(Map.get(raw, "lfo_rate"), current.lfo_rate),
      lfo_depth: to_float(Map.get(raw, "lfo_depth"), current.lfo_depth),
      lfo_shape: Map.get(raw, "lfo_shape", current.lfo_shape),
      lfo_target: Map.get(raw, "lfo_target", current.lfo_target),
      chorus_rate: to_float(Map.get(raw, "chorus_rate"), current.chorus_rate),
      chorus_depth: to_float(Map.get(raw, "chorus_depth"), current.chorus_depth),
      chorus_mix: to_float(Map.get(raw, "chorus_mix"), current.chorus_mix),
      reverb_decay: to_float(Map.get(raw, "reverb_decay"), current.reverb_decay),
      reverb_mix: to_float(Map.get(raw, "reverb_mix"), current.reverb_mix),
      volume: to_float(Map.get(raw, "volume"), current.volume)
    }
  end

  # Safely coerce a value to float, falling back to `default` on nil or error.
  defp to_float(nil, default), do: default
  defp to_float(v, _default) when is_float(v), do: v
  defp to_float(v, _default) when is_integer(v), do: v / 1.0
  defp to_float(_, default), do: default

  # Safely coerce a value to integer, falling back to `default` on nil or error.
  defp to_int(nil, default), do: default
  defp to_int(v, _default) when is_integer(v), do: v
  defp to_int(v, _default) when is_float(v), do: round(v)
  defp to_int(_, default), do: default

  defp apply_slider_update(state, %{"track_id" => track_id, "volume" => volume}) do
    track_state =
      Map.get(state.tracks, track_id, default_track_state())
      |> Map.put(:volume, volume)

    put_in(state, [:tracks, track_id], track_state)
  end

  defp apply_slider_update(state, %{"master_volume" => volume}) do
    %{state | master_volume: volume}
  end

  defp apply_slider_update(state, %{"playing" => playing}) do
    %{state | playing: playing}
  end

  defp apply_slider_update(state, %{"track_id" => track_id, "muted" => muted}) do
    track_state =
      Map.get(state.tracks, track_id, default_track_state())
      |> Map.put(:muted, muted)

    put_in(state, [:tracks, track_id], track_state)
  end

  # Only the three known eq band atoms are permitted; the `when` guard prevents
  # unknown strings from reaching `String.to_existing_atom/1`.
  defp apply_slider_update(state, %{
         "track_id" => track_id,
         "eq_band" => band,
         "eq_value" => value
       })
       when band in ["low", "mid", "high"] do
    track_state = Map.get(state.tracks, track_id, default_track_state())
    atom_band = String.to_existing_atom(band)
    new_eq = Map.put(track_state.eq, atom_band, value)
    put_in(state, [:tracks, track_id], %{track_state | eq: new_eq})
  end

  defp apply_slider_update(state, _unknown), do: state

  defp default_track_state do
    %{volume: 1.0, muted: false, eq: %{low: 0.0, mid: 0.0, high: 0.0}}
  end

  defp default_synth_params do
    %{
      osc_shape: "saw",
      frequency: 440.0,
      unison_voices: 1,
      unison_detune: 0.0,
      unison_spread: 0.0,
      cutoff: 5000.0,
      resonance: 0.0,
      filter_type: "svf",
      drive: 1.0,
      distortion_type: "off",
      distortion_amount: 0.0,
      lfo_rate: 1.0,
      lfo_depth: 0.0,
      lfo_shape: "sine",
      lfo_target: "cutoff",
      chorus_rate: 0.5,
      chorus_depth: 0.0,
      chorus_mix: 0.0,
      reverb_decay: 0.3,
      reverb_mix: 0.0,
      volume: 0.8
    }
  end

  defp serialize_state(state) do
    %{
      project_id: state.project_id,
      tracks: state.tracks,
      master_volume: state.master_volume,
      playing: state.playing,
      playhead_ms: state.playhead_ms,
      synth_params: state.synth_params
    }
  end
end

defmodule Backend.DawSession.ProjectSession do
  @moduledoc """
  GenServer holding the authoritative project state and coordinating the
  Rust DSP engine for a single project.

  This is the renamed + enhanced version of the former `SessionServer`.

  ## Responsibilities

  * **Project state** — mixer params (volumes, mutes, pans, EQ), synth params.
  * **Rust engine** — owns the `ResourceArc<ProjectEngine>` for timeline playback.
    On init, fires async tasks to download + decode all tracks from S3.
  * **Audio routing** — synth render results are returned to callers (channels).
    Timeline chunks are served via `mix_chunk/3` called by `UserSession`.
  * **User tracking** — `active_users` map of connected users (for broadcast).

  ## Two audio pipelines

  ### Synthesizer (event-driven)
  `patch_and_render/2`, `render_bar/3`, `render_note_preview/5` — unchanged
  from the original SessionServer.  Pure function NIFs, no engine state.

  ### Timeline playback (stateful)
  `mix_chunk/3` — delegates to `Backend.DSP.mix_chunk` with the engine ref.
  `UserSession` calls this on its pacing timer ticks.
  """
  use GenServer

  require Logger

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  def start_link(project_id) do
    GenServer.start_link(__MODULE__, project_id, name: via(project_id))
  end

  @doc "Ensure a project session process is running."
  def ensure_started(project_id) do
    case GenServer.whereis(via(project_id)) do
      nil -> Backend.DawSession.SessionSupervisor.start_session(project_id)
      pid -> {:ok, pid}
    end
  end

  @doc "Get the full state snapshot (used on channel join)."
  def get_state(project_id) do
    GenServer.call(via(project_id), :get_state)
  end

  @doc "Apply a mixer slider/parameter update from a client."
  def update_slider(project_id, params) do
    GenServer.cast(via(project_id), {:update_slider, params})
  end

  @doc "Get the current synthesizer parameters for a specific design view."
  def get_synth_params(project_id, view_id \\ nil) do
    GenServer.call(via(project_id), {:get_synth_params, view_id})
  end

  @doc "Get the raw PCM binary from the last bar render for a specific design view."
  def get_last_bar_render(project_id, view_id \\ nil) do
    GenServer.call(via(project_id), {:get_last_bar_render, view_id})
  end

  @doc "Render a polyphonic bar from note events."
  def render_bar(project_id, notes, bar_duration_ms, view_id \\ nil) do
    GenServer.call(via(project_id), {:render_bar, notes, bar_duration_ms, view_id}, :infinity)
  end

  @doc "Render a short note preview (async, cast + reply-via-pid)."
  def render_note_preview(project_id, frequency, duration_secs, midi, reply_pid, view_id \\ nil) do
    GenServer.cast(
      via(project_id),
      {:render_note_preview, frequency, duration_secs, midi, reply_pid, view_id}
    )
  end

  @doc "Merge synth params, render via NIF, return binary frame."
  def patch_and_render(project_id, raw_params, view_id \\ nil) do
    GenServer.call(via(project_id), {:patch_and_render, raw_params, view_id}, :infinity)
  end

  @doc "Merge synth params without rendering audio. Used for live parameter sync."
  def sync_params(project_id, raw_params, view_id \\ nil) do
    GenServer.call(via(project_id), {:sync_params, raw_params, view_id})
  end

  @doc """
  Mix a chunk of timeline audio at the given playhead position.

  Called by `UserSession` on its pacing timer ticks.  Delegates to the
  Rust `mix_chunk` NIF via the engine ResourceArc.
  """
  def mix_chunk(project_id, start_ms, duration_ms) do
    GenServer.call(via(project_id), {:mix_chunk, start_ms, duration_ms})
  end

  @doc "Register a user as active in this project session."
  def register_user(project_id, username, channel_pid) do
    GenServer.cast(via(project_id), {:register_user, username, channel_pid})
  end

  @doc "Unregister a user from this project session."
  def unregister_user(project_id, username) do
    GenServer.cast(via(project_id), {:unregister_user, username})
  end

  @doc "Notify the engine that a track was added/moved/removed. Rebuilds the timeline."
  def rebuild_timeline(project_id) do
    GenServer.cast(via(project_id), :rebuild_timeline)
  end

  @doc "Load a newly created track into the engine and rebuild the timeline."
  def load_and_rebuild(project_id, track) do
    GenServer.cast(via(project_id), {:load_and_rebuild, track})
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(project_id) do
    # Initialize the Rust timeline engine.
    engine =
      case Backend.DSP.init_engine(project_id) do
        {:ok, ref} ->
          ref

        ref when is_reference(ref) ->
          ref

        other ->
          # ResourceArc returns the ref directly (not wrapped in {:ok, ...})
          other
      end

    # Fire async tasks to download + decode all project tracks from S3.
    spawn_track_loading(project_id, engine)

    state = %{
      project_id: project_id,
      engine: engine,
      tracks_loaded: MapSet.new(),
      # Active users: %{username => channel_pid}
      active_users: %{},
      # Per-user design views: %{view_id => %{synth_params, last_bar_render, ...}}
      design_views: %{},
      # Mixer state
      tracks: %{},
      master_volume: 1.0,
      playing: false,
      playhead_ms: 0,
      # Synthesizer state — atom-keyed for NIF
      synth_params: default_synth_params(),
      # Last bar render result (for save_sample)
      last_bar_render: nil,
      last_bar_duration_ms: nil,
      last_bar_notes: nil
    }

    {:ok, state}
  end

  # ── State queries ─────────────────────────────────────────────────────────

  @impl true
  def handle_call(:get_state, _from, state) do
    {:reply, serialize_state(state), state}
  end

  @impl true
  def handle_call({:get_synth_params, view_id}, _from, state) do
    synth_params = get_view_synth_params(state, view_id)
    {:reply, synth_params, state}
  end

  @impl true
  def handle_call({:get_last_bar_render, view_id}, _from, state) do
    view = get_or_create_view(state, view_id)

    case view.last_bar_render do
      {:ok, binary} ->
        pcm_binary = binary_part(binary, 516, byte_size(binary) - 516)
        {:reply, {:ok, pcm_binary}, state}

      _ ->
        {:reply, {:error, :no_render}, state}
    end
  end

  # ── Timeline chunk mixing ────────────────────────────────────────────────

  @impl true
  def handle_call({:mix_chunk, start_ms, duration_ms}, _from, state) do
    result =
      try do
        binary = Backend.DSP.mix_chunk(state.engine, start_ms, duration_ms)
        {:ok, binary}
      rescue
        e -> {:error, Exception.message(e)}
      end

    {:reply, result, state}
  end

  # ── Synth render (unchanged from SessionServer) ──────────────────────────

  @impl true
  def handle_call({:patch_and_render, raw_params, view_id}, _from, state) do
    current_params = get_view_synth_params(state, view_id)
    new_synth_params = merge_synth_params(current_params, raw_params)
    new_state = put_view_field(state, view_id, :synth_params, new_synth_params)

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
  def handle_call({:sync_params, raw_params, view_id}, _from, state) do
    current_params = get_view_synth_params(state, view_id)
    new_synth_params = merge_synth_params(current_params, raw_params)
    new_state = put_view_field(state, view_id, :synth_params, new_synth_params)
    {:reply, :ok, new_state}
  end

  @impl true
  def handle_call({:render_bar, notes, bar_duration_ms, view_id}, _from, state) do
    synth_params = get_view_synth_params(state, view_id)
    sample_rate = 44_100
    bar_duration_secs = bar_duration_ms / 1000.0
    total_samples = round(sample_rate * bar_duration_secs)

    tasks =
      Enum.map(notes, fn note ->
        Task.async(fn ->
          freq = to_float(note["frequency"], 440.0)
          start_ms = to_float(note["start_ms"], 0.0)
          end_ms = to_float(note["end_ms"], bar_duration_ms / 1.0)
          duration_secs = max((end_ms - start_ms) / 1000.0, 0.01)
          start_sample = round(start_ms / 1000.0 * sample_rate)

          voice_params = %{synth_params | frequency: freq}
          pcm_binary = Backend.DSP.render_voice_pcm(voice_params, duration_secs)

          {pcm_binary, start_sample}
        end)
      end)

    results = Task.await_many(tasks, :infinity)
    {pcm_list, offsets} = Enum.unzip(results)

    result =
      try do
        binary = Backend.DSP.mix_voices(pcm_list, offsets, total_samples)
        {:ok, binary}
      rescue
        e -> {:error, Exception.message(e)}
      end

    new_state =
      case result do
        {:ok, _binary} ->
          state
          |> put_view_field(view_id, :last_bar_render, result)
          |> put_view_field(view_id, :last_bar_duration_ms, bar_duration_ms)
          |> put_view_field(view_id, :last_bar_notes, notes)

        _ ->
          state
      end

    {:reply, result, new_state}
  end

  # ── Casts ─────────────────────────────────────────────────────────────────

  @impl true
  def handle_cast({:update_slider, params}, state) do
    state = apply_slider_update(state, params)

    # Also forward volume/mute/pan changes to the Rust engine for timeline mixing.
    sync_track_params_to_engine(state)

    {:noreply, state}
  end

  @impl true
  def handle_cast(
        {:render_note_preview, frequency, duration_secs, midi, reply_pid, view_id},
        state
      ) do
    synth_params = get_view_synth_params(state, view_id)
    voice_params = %{synth_params | frequency: frequency}

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

  @impl true
  def handle_cast({:register_user, username, channel_pid}, state) do
    {:noreply, %{state | active_users: Map.put(state.active_users, username, channel_pid)}}
  end

  @impl true
  def handle_cast({:unregister_user, username}, state) do
    {:noreply, %{state | active_users: Map.delete(state.active_users, username)}}
  end

  @impl true
  def handle_cast(:rebuild_timeline, state) do
    do_rebuild_timeline(state)
    {:noreply, state}
  end

  @impl true
  def handle_cast({:load_and_rebuild, track}, state) do
    session_name = via(state.project_id)
    engine = state.engine

    Task.start(fn ->
      try do
        case ExAws.S3.get_object("cloud-daw", track.s3_key)
             |> ExAws.request() do
          {:ok, %{body: body}} ->
            Backend.DSP.decode_and_load_track(
              engine,
              track.id,
              body,
              track.position_ms,
              0
            )

            case GenServer.whereis(session_name) do
              nil -> :ok
              pid -> send(pid, {:track_loaded, track.id})
            end

          {:error, reason} ->
            Logger.warning(
              "Failed to download new track #{track.id} (#{track.s3_key}): #{inspect(reason)}"
            )
        end
      rescue
        e ->
          Logger.warning("New track loading error for #{track.id}: #{Exception.message(e)}")
      end
    end)

    {:noreply, state}
  end

  # ── Info handlers ─────────────────────────────────────────────────────────

  @impl true
  def handle_info({:track_loaded, track_id}, state) do
    Logger.info("Track #{track_id} loaded into engine for project #{state.project_id}")
    new_state = %{state | tracks_loaded: MapSet.put(state.tracks_loaded, track_id)}
    do_rebuild_timeline(new_state)
    {:noreply, new_state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  defp via(project_id) do
    {:via, Registry, {Backend.SessionRegistry, project_id}}
  end

  # Fire async tasks to download all tracks from S3 and decode them.
  defp spawn_track_loading(project_id, engine) do
    session_name = via(project_id)

    Task.start(fn ->
      tracks = Backend.Projects.list_tracks(project_id)

      Enum.each(tracks, fn track ->
        Task.start(fn ->
          try do
            case ExAws.S3.get_object("cloud-daw", track.s3_key)
                 |> ExAws.request() do
              {:ok, %{body: body}} ->
                Backend.DSP.decode_and_load_track(
                  engine,
                  track.id,
                  body,
                  track.position_ms,
                  0
                )

                # Notify the ProjectSession that this track is ready.
                case GenServer.whereis(session_name) do
                  nil -> :ok
                  pid -> send(pid, {:track_loaded, track.id})
                end

              {:error, reason} ->
                Logger.warning(
                  "Failed to download track #{track.id} (#{track.s3_key}): #{inspect(reason)}"
                )
            end
          rescue
            e ->
              Logger.warning("Track loading error for #{track.id}: #{Exception.message(e)}")
          end
        end)
      end)
    end)
  end

  # Rebuild the interval tree from the current DB state.
  defp do_rebuild_timeline(state) do
    tracks = Backend.Projects.list_tracks(state.project_id)

    clips =
      Enum.filter(tracks, fn t -> MapSet.member?(state.tracks_loaded, t.id) end)
      |> Enum.map(fn t ->
        %{
          clip_id: t.id,
          track_id: t.id,
          start_ms: t.position_ms,
          # Approximate end; real end is computed from decoded duration.
          # For loaded tracks the engine already has the accurate clip.
          end_ms: t.position_ms + 300_000,
          source_offset_ms: 0
        }
      end)

    try do
      Backend.DSP.rebuild_timeline(state.engine, clips)
    rescue
      e -> Logger.warning("rebuild_timeline failed: #{Exception.message(e)}")
    end
  end

  # Sync volume/mute/pan state to the Rust engine for timeline mixing.
  defp sync_track_params_to_engine(state) do
    params =
      Enum.map(state.tracks, fn {track_id_str, track_state} ->
        track_id =
          case track_id_str do
            id when is_integer(id) -> id
            id when is_binary(id) -> String.to_integer(id)
          end

        %{
          track_id: track_id,
          volume: track_state.volume,
          muted: track_state.muted,
          pan: Map.get(track_state, :pan, 0.0)
        }
      end)

    if params != [] do
      try do
        Backend.DSP.set_track_params(state.engine, params)
      rescue
        _ -> :ok
      end
    end
  end

  # ── Synth param helpers (unchanged) ───────────────────────────────────────

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
      volume: to_float(Map.get(raw, "volume"), current.volume),
      # Amp envelope (ADSR)
      amp_attack_ms: to_float(Map.get(raw, "amp_attack_ms"), current.amp_attack_ms),
      amp_decay_ms: to_float(Map.get(raw, "amp_decay_ms"), current.amp_decay_ms),
      amp_sustain: to_float(Map.get(raw, "amp_sustain"), current.amp_sustain),
      amp_release_ms: to_float(Map.get(raw, "amp_release_ms"), current.amp_release_ms),
      # Filter envelope (ADSR)
      filter_attack_ms: to_float(Map.get(raw, "filter_attack_ms"), current.filter_attack_ms),
      filter_decay_ms: to_float(Map.get(raw, "filter_decay_ms"), current.filter_decay_ms),
      filter_sustain: to_float(Map.get(raw, "filter_sustain"), current.filter_sustain),
      filter_release_ms: to_float(Map.get(raw, "filter_release_ms"), current.filter_release_ms),
      filter_env_depth: to_float(Map.get(raw, "filter_env_depth"), current.filter_env_depth)
    }
  end

  defp to_float(nil, default), do: default
  defp to_float(v, _default) when is_float(v), do: v
  defp to_float(v, _default) when is_integer(v), do: v / 1.0
  defp to_float(_, default), do: default

  defp to_int(nil, default), do: default
  defp to_int(v, _default) when is_integer(v), do: v
  defp to_int(v, _default) when is_float(v), do: round(v)
  defp to_int(_, default), do: default

  # ── Slider update helpers (unchanged) ─────────────────────────────────────

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

  defp apply_slider_update(state, %{"track_id" => track_id, "solo" => solo}) do
    track_state =
      Map.get(state.tracks, track_id, default_track_state())
      |> Map.put(:solo, solo)

    put_in(state, [:tracks, track_id], track_state)
  end

  defp apply_slider_update(state, %{"track_id" => track_id, "pan" => pan}) do
    clamped = max(-1.0, min(1.0, pan / 1.0))

    track_state =
      Map.get(state.tracks, track_id, default_track_state())
      |> Map.put(:pan, clamped)

    put_in(state, [:tracks, track_id], track_state)
  end

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
    %{volume: 1.0, muted: false, solo: false, pan: 0.0, eq: %{low: 0.0, mid: 0.0, high: 0.0}}
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
      volume: 0.8,
      # Amp envelope
      amp_attack_ms: 5.0,
      amp_decay_ms: 100.0,
      amp_sustain: 1.0,
      amp_release_ms: 200.0,
      # Filter envelope
      filter_attack_ms: 10.0,
      filter_decay_ms: 300.0,
      filter_sustain: 0.0,
      filter_release_ms: 200.0,
      filter_env_depth: 0.0
    }
  end

  defp serialize_state(state) do
    # Serialize design views: only synth_params (no binaries).
    design_views_json =
      Map.new(state.design_views, fn {view_id, view} ->
        {view_id, %{synth_params: view.synth_params}}
      end)

    %{
      project_id: state.project_id,
      tracks: state.tracks,
      master_volume: state.master_volume,
      playing: state.playing,
      playhead_ms: state.playhead_ms,
      synth_params: state.synth_params,
      design_views: design_views_json
    }
  end

  # ── Design view helpers ───────────────────────────────────────────────────

  defp default_view do
    %{
      synth_params: default_synth_params(),
      last_bar_render: nil,
      last_bar_duration_ms: nil,
      last_bar_notes: nil
    }
  end

  defp get_or_create_view(state, nil), do: default_view_from_state(state)

  defp get_or_create_view(state, view_id) do
    Map.get(state.design_views, view_id, default_view())
  end

  defp default_view_from_state(state) do
    %{
      synth_params: state.synth_params,
      last_bar_render: state.last_bar_render,
      last_bar_duration_ms: state.last_bar_duration_ms,
      last_bar_notes: state.last_bar_notes
    }
  end

  defp get_view_synth_params(state, nil), do: state.synth_params

  defp get_view_synth_params(state, view_id) do
    case Map.get(state.design_views, view_id) do
      nil -> default_synth_params()
      view -> view.synth_params
    end
  end

  defp put_view_field(state, nil, field, value) do
    Map.put(state, field, value)
  end

  defp put_view_field(state, view_id, field, value) do
    view = get_or_create_view(state, view_id)
    updated_view = Map.put(view, field, value)
    %{state | design_views: Map.put(state.design_views, view_id, updated_view)}
  end
end

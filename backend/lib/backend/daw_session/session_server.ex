defmodule Backend.DawSession.SessionServer do
  @moduledoc """
  GenServer holding the live mixer state for a single project session.
  This is the authoritative source of truth for all real-time mixer parameters.
  State is volatile (RAM only) — never auto-persisted to the database.
  """
  use GenServer

  # --- Public API ---

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

  @doc "Get the full mixer state snapshot (used on channel join)."
  def get_state(project_id) do
    GenServer.call(via(project_id), :get_state)
  end

  @doc "Apply a slider/parameter update from a client."
  def update_slider(project_id, params) do
    GenServer.cast(via(project_id), {:update_slider, params})
  end

  # --- Callbacks ---

  @impl true
  def init(project_id) do
    state = %{
      project_id: project_id,
      tracks: %{},
      master_volume: 1.0,
      playing: false,
      playhead_ms: 0
    }

    {:ok, state}
  end

  @impl true
  def handle_call(:get_state, _from, state) do
    {:reply, serialize_state(state), state}
  end

  @impl true
  def handle_cast({:update_slider, params}, state) do
    state = apply_slider_update(state, params)
    {:noreply, state}
  end

  # --- Internals ---

  defp via(project_id) do
    {:via, Registry, {Backend.SessionRegistry, project_id}}
  end

  defp apply_slider_update(state, %{"track_id" => track_id, "volume" => volume}) do
    track_state =
      Map.get(state.tracks, track_id, default_track_state())
      |> Map.put(:volume, volume)

    put_in(state, [:tracks, track_id], track_state)
  end

  defp apply_slider_update(state, %{"master_volume" => volume}) do
    %{state | master_volume: volume}
  end

  defp apply_slider_update(state, _unknown), do: state

  defp default_track_state do
    %{volume: 1.0, muted: false, eq: %{low: 0.0, mid: 0.0, high: 0.0}}
  end

  defp serialize_state(state) do
    %{
      project_id: state.project_id,
      tracks: state.tracks,
      master_volume: state.master_volume,
      playing: state.playing,
      playhead_ms: state.playhead_ms
    }
  end
end

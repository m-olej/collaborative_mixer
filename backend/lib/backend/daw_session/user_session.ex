defmodule Backend.DawSession.UserSession do
  @moduledoc """
  Per-user session GenServer for audio delivery and playback pacing.

  Each connected WebSocket user gets their own `UserSession` process.
  This process owns:

  * **Audio sync preferences** — per-view toggle controlling whether the user
    receives mixed polyphonic audio from all users or only their own.
  * **Timeline playback cursor** — position, playing state, pacing timer.
  * **Audio delivery** — all audio frames destined for this user flow through
    `deliver_audio/3`, which forwards to the channel process via `send/2`.

  ## Burst & Pace Protocol

  On `start_playback`:
  1. Request a 200 ms chunk from the ProjectSession engine (pre-roll burst).
  2. Push the burst immediately to the client to prime the jitter buffer.
  3. Start a `:timer.send_interval` every 50 ms.
  4. Each tick requests a 50 ms chunk and pushes it to the client.

  On `seek`: cancel timer → burst from new position → restart timer.
  On `stop_playback`: cancel timer, clear playing state.

  ## Registration

  Registered in `Backend.SessionRegistry` keyed by `{:user, project_id, username}`.
  """
  use GenServer

  require Logger

  alias Backend.DawSession.ProjectSession

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  def start_link({project_id, username}) do
    GenServer.start_link(__MODULE__, {project_id, username}, name: via(project_id, username))
  end

  @doc "Set the channel process that will receive audio pushes."
  def set_channel_pid(project_id, username, pid) do
    GenServer.cast(via(project_id, username), {:set_channel_pid, pid})
  end

  @doc "Deliver an audio frame to this user's channel."
  def deliver_audio(project_id, username, view_id, binary_frame) do
    GenServer.cast(via(project_id, username), {:deliver_audio, view_id, binary_frame})
  end

  @doc "Set the sync toggle for a specific view."
  def set_sync(project_id, username, view_id, enabled) do
    GenServer.cast(via(project_id, username), {:set_sync, view_id, enabled})
  end

  @doc "Get the sync state for a specific view."
  def get_sync(project_id, username, view_id) do
    GenServer.call(via(project_id, username), {:get_sync, view_id})
  end

  @doc "Get all sync preferences for this user."
  def get_all_sync(project_id, username) do
    GenServer.call(via(project_id, username), :get_all_sync)
  end

  @doc """
  Start timeline playback from the given cursor position.

  Triggers the burst & pace protocol:
  1. 200 ms pre-roll burst pushed immediately.
  2. 50 ms paced chunks pushed via `:timer.send_interval`.
  """
  def start_playback(project_id, username, cursor_ms, view_id) do
    GenServer.cast(via(project_id, username), {:start_playback, cursor_ms, view_id})
  end

  @doc "Seek to a new position (cancels current pacing, triggers new burst)."
  def seek(project_id, username, cursor_ms, view_id) do
    GenServer.cast(via(project_id, username), {:seek, cursor_ms, view_id})
  end

  @doc "Stop timeline playback."
  def stop_playback(project_id, username) do
    GenServer.cast(via(project_id, username), :stop_playback)
  end

  @doc "Check if this user is currently playing."
  def playing?(project_id, username) do
    GenServer.call(via(project_id, username), :playing?)
  end

  @doc "Get current cursor position."
  def get_cursor(project_id, username) do
    GenServer.call(via(project_id, username), :get_cursor)
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init({project_id, username}) do
    state = %{
      project_id: project_id,
      username: username,
      channel_pid: nil,
      # Per-view audio sync preferences: %{view_id => boolean}
      sync_by_view: %{},
      # Timeline playback state
      cursor_ms: 0,
      playing: false,
      timer_ref: nil,
      playback_view_id: "mixer",
      tick_count: 0
    }

    {:ok, state}
  end

  @impl true
  def handle_cast({:set_channel_pid, pid}, state) do
    {:noreply, %{state | channel_pid: pid}}
  end

  @impl true
  def handle_cast({:deliver_audio, view_id, binary_frame}, state) do
    if state.channel_pid && Process.alive?(state.channel_pid) do
      send(state.channel_pid, {:deliver_audio, view_id, binary_frame})
    end

    {:noreply, state}
  end

  @impl true
  def handle_cast({:set_sync, view_id, enabled}, state) do
    {:noreply, %{state | sync_by_view: Map.put(state.sync_by_view, view_id, enabled)}}
  end

  @impl true
  def handle_cast({:start_playback, cursor_ms, view_id}, state) do
    cursor_ms = round(cursor_ms)

    Logger.debug(
      "[UserSession] start_playback user=#{state.username} cursor=#{cursor_ms}ms view=#{view_id} project=#{state.project_id}"
    )

    state = cancel_timer(state)

    # Pre-roll burst: 200 ms chunk pushed immediately.
    case ProjectSession.mix_chunk(state.project_id, cursor_ms, 200) do
      {:ok, burst_binary} ->
        Logger.debug(
          "[UserSession] burst OK user=#{state.username} #{byte_size(burst_binary)} bytes from #{cursor_ms}ms"
        )

        deliver_to_channel(state, view_id, burst_binary)

      {:error, reason} ->
        Logger.debug("[UserSession] burst FAILED user=#{state.username}: #{inspect(reason)}")
    end

    # Start paced push: 50 ms interval.
    new_cursor = cursor_ms + 200
    {:ok, timer_ref} = :timer.send_interval(50, self(), :push_chunk)

    Logger.debug(
      "[UserSession] pacing started user=#{state.username} next_cursor=#{new_cursor}ms"
    )

    {:noreply,
     %{
       state
       | cursor_ms: new_cursor,
         playing: true,
         timer_ref: timer_ref,
         playback_view_id: view_id,
         tick_count: 0
     }}
  end

  @impl true
  def handle_cast({:seek, cursor_ms, view_id}, state) do
    cursor_ms = round(cursor_ms)

    Logger.debug(
      "[UserSession] seek user=#{state.username} to #{cursor_ms}ms view=#{view_id} project=#{state.project_id}"
    )

    state = cancel_timer(state)

    # New burst from seek position.
    case ProjectSession.mix_chunk(state.project_id, cursor_ms, 200) do
      {:ok, burst_binary} ->
        Logger.debug(
          "[UserSession] seek burst OK user=#{state.username} #{byte_size(burst_binary)} bytes"
        )

        deliver_to_channel(state, view_id, burst_binary)

      {:error, reason} ->
        Logger.debug("[UserSession] seek burst FAILED user=#{state.username}: #{inspect(reason)}")
    end

    new_cursor = cursor_ms + 200
    {:ok, timer_ref} = :timer.send_interval(50, self(), :push_chunk)

    {:noreply,
     %{
       state
       | cursor_ms: new_cursor,
         playing: true,
         timer_ref: timer_ref,
         playback_view_id: view_id,
         tick_count: 0
     }}
  end

  @impl true
  def handle_cast(:stop_playback, state) do
    Logger.debug(
      "[UserSession] stop_playback user=#{state.username} at cursor=#{state.cursor_ms}ms project=#{state.project_id}"
    )

    {:noreply, cancel_timer(%{state | playing: false})}
  end

  # Pacing timer tick — request and push the next 50 ms chunk.
  @impl true
  def handle_info(:push_chunk, state) do
    if state.playing do
      # Check if we've passed the end of the timeline (auto-stop).
      timeline_end = ProjectSession.get_timeline_end(state.project_id)

      if timeline_end > 0 and state.cursor_ms > timeline_end do
        # Past all clips — stop playback and notify the client.
        Logger.debug(
          "[UserSession] auto-stop user=#{state.username} cursor=#{state.cursor_ms}ms > timeline_end=#{timeline_end}ms"
        )

        if state.channel_pid && Process.alive?(state.channel_pid) do
          send(state.channel_pid, :playback_ended)
        end

        {:noreply, cancel_timer(%{state | playing: false})}
      else
        case ProjectSession.mix_chunk(state.project_id, state.cursor_ms, 50) do
          {:ok, binary} ->
            deliver_to_channel(state, state.playback_view_id, binary)

          {:error, reason} ->
            Logger.debug(
              "[UserSession] push_chunk FAILED user=#{state.username} cursor=#{state.cursor_ms}ms: #{inspect(reason)}"
            )
        end

        # Periodic playhead sync: every 10th tick (~500 ms) notify the client
        # of the server-authoritative cursor position to prevent drift.
        new_cursor = state.cursor_ms + 50
        tick_count = Map.get(state, :tick_count, 0) + 1

        if (rem(tick_count, 10) == 0 and state.channel_pid) && Process.alive?(state.channel_pid) do
          Logger.debug(
            "[UserSession] playhead_sync user=#{state.username} cursor=#{new_cursor}ms tick=#{tick_count}"
          )

          send(state.channel_pid, {:playhead_sync, new_cursor})
        end

        {:noreply, %{state | cursor_ms: new_cursor, tick_count: tick_count}}
      end
    else
      {:noreply, state}
    end
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call({:get_sync, view_id}, _from, state) do
    {:reply, Map.get(state.sync_by_view, view_id, false), state}
  end

  @impl true
  def handle_call(:get_all_sync, _from, state) do
    {:reply, state.sync_by_view, state}
  end

  @impl true
  def handle_call(:playing?, _from, state) do
    {:reply, state.playing, state}
  end

  @impl true
  def handle_call(:get_cursor, _from, state) do
    {:reply, state.cursor_ms, state}
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  defp via(project_id, username) do
    {:via, Registry, {Backend.SessionRegistry, {:user, project_id, username}}}
  end

  defp cancel_timer(%{timer_ref: nil} = state), do: state

  defp cancel_timer(%{timer_ref: ref} = state) do
    :timer.cancel(ref)
    %{state | timer_ref: nil}
  end

  defp deliver_to_channel(state, view_id, binary) do
    if state.channel_pid && Process.alive?(state.channel_pid) do
      send(state.channel_pid, {:deliver_audio, view_id, binary})
    end
  end
end

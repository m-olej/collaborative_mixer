defmodule BackendWeb.ProjectChannel do
  @moduledoc """
  Channel for real-time mixer collaboration within a project session.
  Handles WebSocket communication for slider updates and audio streaming.
  """
  use BackendWeb, :channel

  alias Backend.DawSession.SessionServer

  @impl true
  def join("project:" <> project_id, _payload, socket) do
    case Integer.parse(project_id) do
      {id, ""} ->
        # Ensure a session GenServer is running for this project
        SessionServer.ensure_started(id)
        state = SessionServer.get_state(id)

        socket = assign(socket, :project_id, id)
        {:ok, %{state: state}, socket}

      _ ->
        {:error, %{reason: "invalid project_id"}}
    end
  end

  @impl true
  def handle_in("slider_update", payload, socket) do
    project_id = socket.assigns.project_id

    SessionServer.update_slider(project_id, payload)

    # Broadcast to all other clients in this channel
    broadcast_from!(socket, "slider_update", payload)
    {:noreply, socket}
  end

  @impl true
  def handle_in("ping", _payload, socket) do
    {:reply, {:ok, %{message: "pong"}}, socket}
  end

  # Receive audio frames from the SessionServer and push as binary
  @impl true
  def handle_info({:audio_frame, binary_frame}, socket) do
    push(socket, "audio_frame", {:binary, binary_frame})
    {:noreply, socket}
  end
end

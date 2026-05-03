defmodule Backend.DawSession.UserSessionSupervisor do
  @moduledoc """
  DynamicSupervisor for per-user session processes.

  Each connected WebSocket user gets a `UserSession` child managed here.
  Started on channel join, stopped on channel terminate/disconnect.
  """
  use DynamicSupervisor

  def start_link(init_arg) do
    DynamicSupervisor.start_link(__MODULE__, init_arg, name: __MODULE__)
  end

  @impl true
  def init(_init_arg) do
    DynamicSupervisor.init(strategy: :one_for_one)
  end

  @doc "Start a UserSession for the given project + username."
  def start_user_session(project_id, username) do
    child_spec = {Backend.DawSession.UserSession, {project_id, username}}
    DynamicSupervisor.start_child(__MODULE__, child_spec)
  end

  @doc "Stop a UserSession for the given project + username."
  def stop_user_session(project_id, username) do
    name = {:via, Registry, {Backend.SessionRegistry, {:user, project_id, username}}}

    case GenServer.whereis(name) do
      nil -> :ok
      pid -> DynamicSupervisor.terminate_child(__MODULE__, pid)
    end
  end
end

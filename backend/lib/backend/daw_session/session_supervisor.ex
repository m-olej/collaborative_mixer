defmodule Backend.DawSession.SessionSupervisor do
  @moduledoc "DynamicSupervisor for per-project mixer session processes."
  use DynamicSupervisor

  def start_link(init_arg) do
    DynamicSupervisor.start_link(__MODULE__, init_arg, name: __MODULE__)
  end

  @impl true
  def init(_init_arg) do
    DynamicSupervisor.init(strategy: :one_for_one)
  end

  @doc "Start a ProjectSession child for the given project."
  def start_session(project_id) do
    child_spec = {Backend.DawSession.ProjectSession, project_id}
    DynamicSupervisor.start_child(__MODULE__, child_spec)
  end
end

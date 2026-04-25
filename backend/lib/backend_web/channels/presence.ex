defmodule BackendWeb.Presence do
  @moduledoc """
  Phoenix Presence for tracking connected users in project sessions.

  Tracks username and color metadata for each connected socket.
  """
  use Phoenix.Presence,
    otp_app: :backend,
    pubsub_server: Backend.PubSub
end

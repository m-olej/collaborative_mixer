defmodule BackendWeb.PingController do
  @moduledoc "Health check endpoint. Verifies the Rust DSP NIF is loaded."
  use BackendWeb, :controller

  def index(conn, _params) do
    dsp_status = Backend.DSP.ping()
    json(conn, %{status: "ok", dsp: dsp_status})
  end
end

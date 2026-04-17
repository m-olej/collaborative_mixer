defmodule Backend.DSP do
  @moduledoc """
  NIF bridge to the Rust DSP engine (native/backend_dsp).
  Each function here is a stub that will be replaced at load time
  by the compiled Rust NIF implementation.
  """
  use Rustler, otp_app: :backend, crate: "backend_dsp"

  @doc "Health check — returns a greeting from the Rust engine."
  def ping, do: :erlang.nif_error(:nif_not_loaded)
end

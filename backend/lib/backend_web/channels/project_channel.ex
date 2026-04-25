defmodule BackendWeb.ProjectChannel do
  @moduledoc """
  Phoenix Channel for real-time collaboration within a project session.

  ## Event routing

  | Direction          | Event           | Payload                | Description                          |
  |--------------------|-----------------|------------------------|--------------------------------------|
  | client → server    | `slider_update` | JSON mixer params      | Fader / EQ change; broadcast to peers|
  | client → server    | `patch_update`  | JSON synth params      | Synth knob change; triggers DSP render|
  | client → server    | `ping`          | any                    | Health check                         |
  | server → client    | `slider_update` | JSON mixer params      | Broadcast from another client        |
  | server → client    | `audio_frame`   | `{:binary, frame}`     | Mixer audio frame (type byte 1)      |
  | server → client    | `audio_buffer`  | `{:binary, frame}`     | Synth audio buffer (type byte 2)     |

  ## `patch_update` flow

  ```
  React knob change
      ↓  (debounced, JSON)
  handle_in("patch_update", payload, socket)
      ↓  GenServer.call (sync — waits for NIF result)
  SessionServer.patch_and_render(project_id, payload)
      ↓  Backend.DSP.render_synth(synth_params, 1.0)  [DirtyCpu NIF]
      ↓  returns {:ok, binary_frame}
  push(socket, "audio_buffer", {:binary, binary_frame})
      ↓  WebSocket binary push
  React: ArrayBuffer → Float32Array → AudioWorklet + Canvas
  ```
  """
  use BackendWeb, :channel

  alias Backend.DawSession.SessionServer
  alias BackendWeb.Presence

  @impl true
  def join("project:" <> project_id, payload, socket) do
    case Integer.parse(project_id) do
      {id, ""} ->
        # Ensure a session GenServer is running for this project.
        # `ensure_started` is idempotent: returns the existing PID if already up.
        SessionServer.ensure_started(id)
        state = SessionServer.get_state(id)

        # Extract user identity from join params (ephemeral, stored in localStorage).
        username = Map.get(payload, "username", "Anonymous")
        color = Map.get(payload, "color", "#6366f1")

        socket =
          socket
          |> assign(:project_id, id)
          |> assign(:username, username)
          |> assign(:user_color, color)

        # Track presence after join (must be done via send to self).
        send(self(), :after_join)

        {:ok, %{state: state}, socket}

      _ ->
        {:error, %{reason: "invalid project_id"}}
    end
  end

  # ---------------------------------------------------------------------------
  # Incoming events — client → server
  # ---------------------------------------------------------------------------

  @doc """
  Handle a synthesizer parameter update from the React UI.

  The payload is a JSON-decoded map with **string keys**, e.g.:
  ```json
  {"osc_shape": "saw", "frequency": 440.0, "cutoff": 2500.0,
   "resonance": 0.7, "drive": 1.2, "volume": 0.8}
  ```

  The SessionServer merges the params, calls the DirtyCpu Rust NIF, and returns
  the binary wire frame.  We push it back as a binary WebSocket message so the
  React client can decode it with zero-copy typed array views:
  ```js
  const fft = new Uint8Array(buffer, 4, 512);
  const pcm = new Float32Array(buffer, 516);
  ```
  """
  @impl true
  def handle_in("patch_update", payload, socket) do
    project_id = socket.assigns.project_id

    case SessionServer.patch_and_render(project_id, payload) do
      {:ok, binary_frame} ->
        # Push the binary frame only to the requesting socket, not to peers.
        # Audio buffers are per-client; every client renders its own sound.
        push(socket, "audio_buffer", {:binary, binary_frame})
        {:noreply, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  @impl true
  def handle_in("slider_update", payload, socket) do
    project_id = socket.assigns.project_id

    SessionServer.update_slider(project_id, payload)

    # Broadcast mixer slider change to all other clients in this session.
    broadcast_from!(socket, "slider_update", payload)
    {:noreply, socket}
  end

  # Handle a polyphonic bar render request.
  # The payload contains a list of note events and the bar duration.
  # Each note is rendered concurrently via Elixir Tasks, then mixed by a Rust NIF.
  # The combined wire frame is pushed back as a `bar_audio` binary event.
  @impl true
  def handle_in("render_bar", payload, socket) do
    project_id = socket.assigns.project_id
    notes = Map.get(payload, "notes", [])
    bar_duration_ms = Map.get(payload, "bar_duration_ms", 2000)

    case SessionServer.render_bar(project_id, notes, bar_duration_ms) do
      {:ok, binary_frame} ->
        push(socket, "bar_audio", {:binary, binary_frame})
        {:reply, {:ok, %{}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  # Handle a keyboard note preview request.
  # Renders a long preview (3 s) of a single note at the given frequency.
  # Uses a cast + Task pattern so multiple notes can render concurrently,
  # giving polyphonic preview without blocking the GenServer.
  # The rendered binary is sent back to this channel process via `handle_info`.
  # The MIDI number is embedded in byte 1 of the binary frame for client-side
  # correlation (so the client knows which key produced which audio).
  @impl true
  def handle_in("note_preview", %{"frequency" => freq, "midi" => midi}, socket) do
    project_id = socket.assigns.project_id
    duration = 3.0

    SessionServer.render_note_preview(project_id, freq, duration, midi, self())
    {:noreply, socket}
  end

  @impl true
  def handle_in("save_sample", %{"name" => name} = payload, socket) do
    project_id = socket.assigns.project_id
    genre = Map.get(payload, "genre")
    input_history = Map.get(payload, "input_history")
    # Ecto :map requires a map, but the frontend sends an array of notes.
    # Wrap it so the jsonb column gets a proper map.
    input_history_map =
      cond do
        is_map(input_history) -> input_history
        is_list(input_history) -> %{"notes" => input_history}
        true -> nil
      end

    bar_duration_ms = Map.get(payload, "bar_duration_ms")
    bar_count = Map.get(payload, "bar_count", 1)

    timestamp = System.system_time(:second)
    # Build a safe s3_key path from the name — keep only alphanumeric + underscores
    slug = name |> String.downcase() |> String.replace(~r/[^a-z0-9]+/, "_")
    s3_key = "synth/#{project_id}/#{slug}_#{timestamp}"

    duration_ms = if is_number(bar_duration_ms), do: round(bar_duration_ms), else: 2000

    # Generate waveform peaks from the last rendered bar audio (if available).
    waveform_peaks =
      case Backend.DawSession.SessionServer.get_last_bar_render(project_id) do
        {:ok, pcm_binary} when is_binary(pcm_binary) ->
          case Backend.DSP.generate_waveform_peaks(pcm_binary, 200) do
            peaks when is_list(peaks) ->
              Enum.map(peaks, fn {min_v, max_v} -> %{"min" => min_v, "max" => max_v} end)

            _ ->
              nil
          end

        _ ->
          nil
      end

    attrs = %{
      "name" => name,
      "genre" => genre,
      "s3_key" => s3_key,
      "duration_ms" => duration_ms,
      "input_history" => input_history_map,
      "bar_count" => bar_count,
      "waveform_peaks" => waveform_peaks
    }

    case Backend.Samples.create_sample(attrs) do
      {:ok, sample} ->
        {:reply, {:ok, %{sample_id: sample.id, name: sample.name}}, socket}

      {:error, changeset} ->
        errors = Ecto.Changeset.traverse_errors(changeset, fn {msg, _opts} -> msg end)
        {:reply, {:error, %{errors: errors}}, socket}
    end
  end

  @impl true
  def handle_in("ping", _payload, socket) do
    {:reply, {:ok, %{message: "pong"}}, socket}
  end

  # ---------------------------------------------------------------------------
  # Collaboration events — cursor tracking and selection
  # ---------------------------------------------------------------------------

  @impl true
  def handle_in("cursor_move", %{"x" => x, "y" => y}, socket) do
    broadcast_from!(socket, "cursor_move", %{
      user: socket.assigns.username,
      color: socket.assigns.user_color,
      x: x,
      y: y
    })

    {:noreply, socket}
  end

  @impl true
  def handle_in("selection_update", payload, socket) do
    broadcast_from!(socket, "selection_update", %{
      user: socket.assigns.username,
      color: socket.assigns.user_color,
      selection: payload
    })

    {:noreply, socket}
  end

  # ---------------------------------------------------------------------------
  # Outgoing events — server → client
  # ---------------------------------------------------------------------------

  # Track presence after successful join.
  @impl true
  def handle_info(:after_join, socket) do
    Presence.track(socket, socket.assigns.username, %{
      color: socket.assigns.user_color,
      online_at: System.system_time(:second)
    })

    push(socket, "presence_state", Presence.list(socket))
    {:noreply, socket}
  end

  # Receive mixer audio frames from the SessionServer (type byte 1) and forward
  # them as binary WebSocket messages to this client.
  @impl true
  def handle_info({:audio_frame, binary_frame}, socket) do
    push(socket, "audio_frame", {:binary, binary_frame})
    {:noreply, socket}
  end

  # Receive note preview audio from a render Task.
  # Embed the MIDI number in byte 1 (padding area) of the binary frame so the
  # client can correlate the response with the originating key press.
  @impl true
  def handle_info({:note_audio, midi, binary_frame}, socket) do
    # Patch byte 1 of the binary frame with the MIDI number.
    <<type, _pad1, pad2, pad3, rest::binary>> = binary_frame
    midi_byte = min(max(midi, 0), 127)
    patched = <<type, midi_byte::8, pad2, pad3, rest::binary>>
    push(socket, "note_audio", {:binary, patched})
    {:noreply, socket}
  end
end

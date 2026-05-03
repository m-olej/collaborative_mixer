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
  ProjectSession.patch_and_render(project_id, payload)
      ↓  Backend.DSP.render_synth(synth_params, 1.0)  [DirtyCpu NIF]
      ↓  returns {:ok, binary_frame}
  push(socket, "audio_buffer", {:binary, binary_frame})
      ↓  WebSocket binary push
  React: ArrayBuffer → Float32Array → AudioWorklet + Canvas
  ```
  """
  use BackendWeb, :channel

  alias Backend.DawSession.ProjectSession
  alias Backend.DawSession.UserSessionSupervisor
  alias Backend.DawSession.UserSession
  alias Backend.DawSession.VoiceStreamer
  alias BackendWeb.Presence

  @impl true
  def join("project:" <> project_id, payload, socket) do
    case Integer.parse(project_id) do
      {id, ""} ->
        # Ensure a session GenServer is running for this project.
        # `ensure_started` is idempotent: returns the existing PID if already up.
        ProjectSession.ensure_started(id)
        state = ProjectSession.get_state(id)

        # Extract user identity from join params (ephemeral, stored in localStorage).
        username = Map.get(payload, "username", "Anonymous")
        color = Map.get(payload, "color", "#6366f1")

        socket =
          socket
          |> assign(:project_id, id)
          |> assign(:username, username)
          |> assign(:user_color, color)
          |> assign(:active_voices, %{})

        # Start a UserSession for this user.
        UserSessionSupervisor.start_user_session(id, username)
        UserSession.set_channel_pid(id, username, self())
        ProjectSession.register_user(id, username, self())

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

  The ProjectSession merges the params, calls the DirtyCpu Rust NIF, and returns
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
    view_id = Map.get(payload, "view_id")
    # Strip view_id from params before forwarding to synth engine.
    synth_params = Map.delete(payload, "view_id")

    case ProjectSession.patch_and_render(project_id, synth_params, view_id) do
      {:ok, binary_frame} ->
        push(socket, "audio_buffer", {:binary, binary_frame})

        # Broadcast the updated synth params to all peers.
        if view_id do
          broadcast_from!(socket, "design_view_update", %{
            view_id: view_id,
            synth_params: synth_params
          })
        end

        {:noreply, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  # Sync synth parameters to server state without rendering audio.
  # Used for live slider/knob changes where audio preview is not needed.
  @impl true
  def handle_in("sync_params", payload, socket) do
    project_id = socket.assigns.project_id
    view_id = Map.get(payload, "view_id")
    synth_params = Map.delete(payload, "view_id")

    ProjectSession.sync_params(project_id, synth_params, view_id)

    # Broadcast to peers so their UI updates.
    if view_id do
      broadcast_from!(socket, "design_view_update", %{
        view_id: view_id,
        synth_params: synth_params
      })
    end

    {:noreply, socket}
  end

  @impl true
  def handle_in("slider_update", payload, socket) do
    project_id = socket.assigns.project_id

    ProjectSession.update_slider(project_id, payload)

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
    view_id = Map.get(payload, "view_id")

    case ProjectSession.render_bar(project_id, notes, bar_duration_ms, view_id) do
      {:ok, binary_frame} ->
        push(socket, "bar_audio", {:binary, binary_frame})
        {:reply, {:ok, %{}}, socket}

      {:error, reason} ->
        {:reply, {:error, %{reason: reason}}, socket}
    end
  end

  # Handle a keyboard note preview request.
  # Spawns a streaming VoiceStreamer process that delivers audio chunks
  # via burst & pace protocol (200 ms burst, then 50 ms ticks).
  # The voice persists until key-up + ADSR release + effects tail decay.
  @impl true
  def handle_in("note_preview", %{"frequency" => freq, "midi" => midi} = payload, socket) do
    project_id = socket.assigns.project_id
    view_id = Map.get(payload, "view_id")

    # Kill any existing voice for this MIDI note (re-trigger).
    socket = stop_voice(socket, midi)

    # Get current synth params from session.
    synth_params = ProjectSession.get_synth_params(project_id, view_id)

    # Spawn a VoiceStreamer that will send us :voice_audio messages.
    {:ok, voice_pid} = VoiceStreamer.start_link({self(), midi, synth_params, freq})
    Process.monitor(voice_pid)

    active_voices = Map.put(socket.assigns.active_voices, midi, voice_pid)
    socket = assign(socket, :active_voices, active_voices)

    # Broadcast key press to peers for collaborative key coloring.
    broadcast_from!(socket, "key_down", %{
      user: socket.assigns.username,
      color: socket.assigns.user_color,
      midi: midi
    })

    {:noreply, socket}
  end

  @impl true
  def handle_in("key_up", %{"midi" => midi}, socket) do
    # Trigger release on the voice (it keeps streaming until envelope + effects done).
    case Map.get(socket.assigns.active_voices, midi) do
      nil -> :ok
      pid -> VoiceStreamer.note_off(pid)
    end

    broadcast_from!(socket, "key_up", %{
      user: socket.assigns.username,
      midi: midi
    })

    {:noreply, socket}
  end

  @impl true
  def handle_in("save_sample", %{"name" => name} = payload, socket) do
    project_id = socket.assigns.project_id
    view_id = Map.get(payload, "view_id")
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
      case Backend.DawSession.ProjectSession.get_last_bar_render(project_id, view_id) do
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
  # Timeline playback events
  # ---------------------------------------------------------------------------

  @impl true
  def handle_in("start_playback", %{"cursor_ms" => cursor_ms}, socket) do
    project_id = socket.assigns.project_id
    username = socket.assigns.username
    view_id = "mixer"

    UserSession.start_playback(project_id, username, cursor_ms, view_id)
    {:noreply, socket}
  end

  @impl true
  def handle_in("stop_playback", _payload, socket) do
    project_id = socket.assigns.project_id
    username = socket.assigns.username

    UserSession.stop_playback(project_id, username)
    {:noreply, socket}
  end

  @impl true
  def handle_in("seek", %{"cursor_ms" => cursor_ms}, socket) do
    project_id = socket.assigns.project_id
    username = socket.assigns.username
    view_id = "mixer"

    UserSession.seek(project_id, username, cursor_ms, view_id)
    {:noreply, socket}
  end

  # ---------------------------------------------------------------------------
  # Audio sync toggle
  # ---------------------------------------------------------------------------

  @impl true
  def handle_in("set_sync", %{"view_id" => view_id, "enabled" => enabled}, socket) do
    project_id = socket.assigns.project_id
    username = socket.assigns.username

    UserSession.set_sync(project_id, username, view_id, enabled)

    broadcast_from!(socket, "sync_update", %{
      user: username,
      view_id: view_id,
      enabled: enabled
    })

    {:reply, {:ok, %{view_id: view_id, enabled: enabled}}, socket}
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
  def handle_in("tracks_dragging", %{"track_ids" => track_ids}, socket) do
    broadcast_from!(socket, "tracks_dragging", %{
      user: socket.assigns.username,
      color: socket.assigns.user_color,
      track_ids: track_ids
    })

    {:noreply, socket}
  end

  @impl true
  def handle_in("tracks_drag_end", _payload, socket) do
    broadcast_from!(socket, "tracks_drag_end", %{
      user: socket.assigns.username
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

  # Receive mixer audio frames from the ProjectSession (type byte 1) and forward
  # them as binary WebSocket messages to this client.
  @impl true
  def handle_info({:audio_frame, binary_frame}, socket) do
    push(socket, "audio_frame", {:binary, binary_frame})
    {:noreply, socket}
  end

  # Receive streaming voice audio from VoiceStreamer.
  # Embed the MIDI number in byte 1 (padding area) of the binary frame so the
  # client can correlate chunks with the originating key press.
  @impl true
  def handle_info({:voice_audio, midi, binary_frame}, socket) do
    <<type, _pad1, pad2, pad3, rest::binary>> = binary_frame
    midi_byte = min(max(midi, 0), 127)
    patched = <<type, midi_byte::8, pad2, pad3, rest::binary>>
    push(socket, "voice_audio", {:binary, patched})
    {:noreply, socket}
  end

  # Voice has finished (envelope done + effects tail silent).
  # Clean up from active voices map and notify the client.
  @impl true
  def handle_info({:voice_done, midi}, socket) do
    active_voices = Map.delete(socket.assigns.active_voices, midi)
    socket = assign(socket, :active_voices, active_voices)
    push(socket, "voice_done", %{midi: midi})
    {:noreply, socket}
  end

  # Handle VoiceStreamer process exits (normal or crash).
  @impl true
  def handle_info({:DOWN, _ref, :process, pid, _reason}, socket) do
    # Remove from active_voices if it's a voice process.
    active_voices =
      socket.assigns.active_voices
      |> Enum.reject(fn {_midi, voice_pid} -> voice_pid == pid end)
      |> Map.new()

    {:noreply, assign(socket, :active_voices, active_voices)}
  end

  # Legacy: Receive note preview audio from old render Task (backward compat).
  @impl true
  def handle_info({:note_audio, midi, binary_frame}, socket) do
    <<type, _pad1, pad2, pad3, rest::binary>> = binary_frame
    midi_byte = min(max(midi, 0), 127)
    patched = <<type, midi_byte::8, pad2, pad3, rest::binary>>
    push(socket, "note_audio", {:binary, patched})
    {:noreply, socket}
  end

  # Receive timeline audio frames from UserSession (burst & pace protocol).
  @impl true
  def handle_info({:deliver_audio, _view_id, binary_frame}, socket) do
    push(socket, "audio_frame", {:binary, binary_frame})
    {:noreply, socket}
  end

  # ---------------------------------------------------------------------------
  # Cleanup
  # ---------------------------------------------------------------------------

  @impl true
  def terminate(_reason, socket) do
    if Map.has_key?(socket.assigns, :project_id) do
      project_id = socket.assigns.project_id
      username = socket.assigns.username

      # Stop all active voice streamers.
      for {_midi, pid} <- Map.get(socket.assigns, :active_voices, %{}) do
        if Process.alive?(pid), do: GenServer.stop(pid, :normal)
      end

      ProjectSession.unregister_user(project_id, username)
      UserSessionSupervisor.stop_user_session(project_id, username)
    end

    :ok
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # Stop an existing voice for a given MIDI note (re-trigger support).
  defp stop_voice(socket, midi) do
    case Map.get(socket.assigns.active_voices, midi) do
      nil ->
        socket

      pid ->
        if Process.alive?(pid), do: GenServer.stop(pid, :normal)
        active_voices = Map.delete(socket.assigns.active_voices, midi)
        assign(socket, :active_voices, active_voices)
    end
  end
end

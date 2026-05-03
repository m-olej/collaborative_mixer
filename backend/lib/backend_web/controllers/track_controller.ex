defmodule BackendWeb.TrackController do
  use BackendWeb, :controller

  alias Backend.Projects
  alias Backend.Samples

  def index(conn, %{"project_id" => project_id}) do
    tracks = Projects.list_tracks(project_id)

    etags =
      Map.new(tracks, fn t ->
        {to_string(t.id), Projects.track_etag(t)}
      end)

    json(conn, %{data: Enum.map(tracks, &track_json/1), etags: etags})
  end

  def show(conn, %{"id" => id}) do
    with {:ok, track} <- Projects.get_track(id) do
      conn
      |> put_resp_header("etag", "\"#{Projects.track_etag(track)}\"")
      |> json(%{data: track_json(track)})
    else
      {:error, :not_found} -> send_resp(conn, 404, "")
    end
  end

  def create(conn, %{"project_id" => project_id, "track" => params}) do
    # Look up the sample to get s3_key and duration info.
    s3_key =
      case params["sample_id"] do
        nil ->
          params["s3_key"] || "unknown"

        sample_id ->
          case Samples.get_sample(sample_id) do
            {:ok, sample} -> sample.s3_key
            {:error, _} -> params["s3_key"] || "unknown"
          end
      end

    track_attrs = %{
      "name" => params["name"] || "Untitled",
      "s3_key" => s3_key,
      "position_ms" => params["position_ms"] || 0,
      "lane_index" => params["lane_index"] || 0
    }

    with {:ok, track} <- Projects.create_track(project_id, track_attrs) do
      # Broadcast to all clients in the project channel.
      BackendWeb.Endpoint.broadcast(
        "project:#{project_id}",
        "track_placed",
        %{track: track_json(track)}
      )

      conn
      |> put_status(201)
      |> put_resp_header("etag", "\"#{Projects.track_etag(track)}\"")
      |> json(%{data: track_json(track)})
    else
      {:error, %Ecto.Changeset{} = changeset} ->
        conn |> put_status(422) |> json(%{errors: format_errors(changeset)})
    end
  end

  def update(conn, %{"project_id" => project_id, "id" => id} = params) do
    raw_etag = get_req_header(conn, "if-match") |> List.first()

    with {:etag_present, etag} when etag != nil <- {:etag_present, raw_etag},
         etag = String.trim(etag, "\""),
         {:ok, track} <- Projects.get_track(id),
         :ok <- Projects.verify_track_etag(track, etag),
         {:ok, updated} <- Projects.update_track(track, params["track"] || %{}) do
      BackendWeb.Endpoint.broadcast(
        "project:#{project_id}",
        "track_moved",
        %{track: track_json(updated)}
      )

      conn
      |> put_resp_header("etag", "\"#{Projects.track_etag(updated)}\"")
      |> json(%{data: track_json(updated)})
    else
      {:etag_present, nil} ->
        send_resp(conn, 428, "")

      {:error, :not_found} ->
        send_resp(conn, 404, "")

      {:error, :etag_mismatch} ->
        send_resp(conn, 412, "")

      {:error, %Ecto.Changeset{} = changeset} ->
        conn |> put_status(422) |> json(%{errors: format_errors(changeset)})
    end
  end

  def delete(conn, %{"project_id" => project_id, "id" => id}) do
    with {:ok, track} <- Projects.get_track(id),
         {:ok, _} <- Projects.delete_track(track) do
      BackendWeb.Endpoint.broadcast(
        "project:#{project_id}",
        "track_removed",
        %{track_id: track.id}
      )

      send_resp(conn, 204, "")
    else
      {:error, :not_found} -> send_resp(conn, 404, "")
    end
  end

  def batch_move(conn, %{"project_id" => project_id, "moves" => moves}) do
    case Projects.batch_move_tracks(project_id, moves) do
      {:ok, updated_tracks} ->
        # Broadcast each moved track to all clients.
        for track <- updated_tracks do
          BackendWeb.Endpoint.broadcast(
            "project:#{project_id}",
            "track_moved",
            %{track: track_json(track)}
          )
        end

        etags =
          Map.new(updated_tracks, fn t ->
            {to_string(t.id), Projects.track_etag(t)}
          end)

        conn
        |> put_status(200)
        |> json(%{
          data: Enum.map(updated_tracks, &track_json/1),
          etags: etags
        })

      {:error, {:etag_mismatch, track_id}} ->
        conn |> put_status(412) |> json(%{error: "etag_mismatch", track_id: track_id})

      {:error, {:not_found, track_id}} ->
        conn |> put_status(404) |> json(%{error: "not_found", track_id: track_id})

      {:error, {:update_failed, track_id, _changeset}} ->
        conn |> put_status(422) |> json(%{error: "update_failed", track_id: track_id})
    end
  end

  defp track_json(track) do
    %{
      id: track.id,
      name: track.name,
      s3_key: track.s3_key,
      position_ms: track.position_ms,
      lane_index: track.lane_index,
      project_id: track.project_id,
      lock_version: track.lock_version,
      inserted_at: track.inserted_at,
      updated_at: track.updated_at
    }
  end

  defp format_errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
      Regex.replace(~r"%{(\w+)}", msg, fn _, key ->
        opts |> Keyword.get(String.to_existing_atom(key), key) |> to_string()
      end)
    end)
  end
end

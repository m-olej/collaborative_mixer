defmodule BackendWeb.ProjectController do
  use BackendWeb, :controller

  alias Backend.Projects

  def index(conn, _params) do
    projects = Projects.list_projects()
    json(conn, %{data: Enum.map(projects, &project_json/1)})
  end

  def show(conn, %{"id" => id}) do
    with {:ok, project} <- Projects.get_project(id) do
      conn
      |> put_resp_header("etag", "\"#{Projects.etag(project)}\"")
      |> json(%{data: project_json(project)})
    else
      {:error, :not_found} -> send_resp(conn, 404, "")
    end
  end

  def create(conn, %{"project" => params}) do
    with {:ok, project} <- Projects.create_project(params) do
      conn
      |> put_status(201)
      |> put_resp_header("etag", "\"#{Projects.etag(project)}\"")
      |> json(%{data: project_json(project)})
    end
  end

  def update(conn, %{"id" => id} = params) do
    raw_etag = get_req_header(conn, "if-match") |> List.first()

    with {:etag_present, etag} when etag != nil <- {:etag_present, raw_etag},
         etag = String.trim(etag, "\""),
         {:ok, project} <- Projects.get_project(id),
         :ok <- Projects.verify_etag(project, etag),
         {:ok, updated} <- Projects.update_project(project, params["project"] || %{}) do
      conn
      |> put_resp_header("etag", "\"#{Projects.etag(updated)}\"")
      |> json(%{data: project_json(updated)})
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

  def delete(conn, %{"id" => id}) do
    with {:ok, project} <- Projects.get_project(id),
         {:ok, _} <- Projects.delete_project(project) do
      send_resp(conn, 204, "")
    else
      {:error, :not_found} -> send_resp(conn, 404, "")
    end
  end

  def merge_tracks(conn, %{"project_id" => project_id} = params) do
    track_ids = params["track_ids"] || []
    new_name = params["new_name"] || "Merged Track"

    case Projects.merge_tracks(project_id, track_ids, new_name) do
      {:ok, new_track} ->
        conn |> put_status(201) |> json(%{data: %{id: new_track.id, name: new_track.name}})

      {:error, :tracks_not_found} ->
        send_resp(conn, 404, "")

      {:error, _reason} ->
        send_resp(conn, 422, "")
    end
  end

  defp project_json(project) do
    %{
      id: project.id,
      name: project.name,
      bpm: project.bpm,
      time_signature: project.time_signature,
      inserted_at: project.inserted_at,
      updated_at: project.updated_at
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

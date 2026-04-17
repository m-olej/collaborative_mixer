defmodule Backend.Projects do
  @moduledoc "Context for managing projects and tracks."

  import Ecto.Query
  alias Backend.Repo
  alias Backend.Projects.{Project, Track}

  # --- Projects ---

  def list_projects do
    Repo.all(Project)
  end

  def get_project(id) do
    case Repo.get(Project, id) do
      nil -> {:error, :not_found}
      project -> {:ok, project}
    end
  end

  def get_project!(id), do: Repo.get!(Project, id)

  def create_project(attrs) do
    %Project{}
    |> Project.changeset(attrs)
    |> Repo.insert()
  end

  def update_project(%Project{} = project, attrs) do
    project
    |> Project.changeset(attrs)
    |> Repo.update()
  end

  def delete_project(%Project{} = project) do
    Repo.delete(project)
  end

  @doc "Compute an ETag string from a project's id and updated_at."
  def etag(%Project{id: id, updated_at: ts}) do
    :crypto.hash(:md5, "#{id}:#{DateTime.to_iso8601(ts)}")
    |> Base.encode16(case: :lower)
  end

  @doc "Verify that the supplied ETag matches the project's current ETag."
  def verify_etag(%Project{} = project, client_etag) do
    if etag(project) == client_etag do
      :ok
    else
      {:error, :etag_mismatch}
    end
  end

  # --- Tracks ---

  def list_tracks(project_id) do
    Track
    |> where([t], t.project_id == ^project_id)
    |> Repo.all()
  end

  def get_track!(id), do: Repo.get!(Track, id)

  def create_track(project_id, attrs) do
    %Track{}
    |> Track.changeset(attrs)
    |> Ecto.Changeset.put_change(:project_id, project_id)
    |> Repo.insert()
  end

  @doc """
  Merge multiple tracks into one new track within a database transaction.
  Deletes the original tracks and creates a merged replacement.
  """
  def merge_tracks(project_id, track_ids, new_name) do
    Repo.transaction(fn ->
      tracks =
        Track
        |> where([t], t.project_id == ^project_id and t.id in ^track_ids)
        |> Repo.all()

      if length(tracks) != length(track_ids) do
        Repo.rollback(:tracks_not_found)
      end

      # TODO: call DSP to merge audio files and upload result to S3
      merged_s3_key = "merged/#{project_id}/#{new_name}_#{System.system_time(:millisecond)}.wav"

      {:ok, new_track} =
        %Track{}
        |> Track.changeset(%{name: new_name, s3_key: merged_s3_key})
        |> Ecto.Changeset.put_change(:project_id, project_id)
        |> Repo.insert()

      {_count, _} =
        Track
        |> where([t], t.id in ^track_ids)
        |> Repo.delete_all()

      new_track
    end)
  end
end

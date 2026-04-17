defmodule Backend.Exports do
  @moduledoc "Context for managing WAV export jobs."

  import Ecto.Query
  alias Backend.Repo
  alias Backend.Exports.Export

  def list_exports(project_id) do
    Export
    |> where([e], e.project_id == ^project_id)
    |> order_by(desc: :inserted_at)
    |> Repo.all()
  end

  def get_export(id) do
    case Repo.get(Export, id) do
      nil -> {:error, :not_found}
      export -> {:ok, export}
    end
  end

  @doc "Find an existing export by its idempotency token."
  def find_by_token(token) do
    Repo.get_by(Export, token: token)
  end

  @doc "Create a new pending export record for a project."
  def create_export(project_id, token) do
    %Export{}
    |> Export.changeset(%{token: token})
    |> Ecto.Changeset.put_change(:project_id, project_id)
    |> Repo.insert()
  end

  @doc "Mark an export as completed with the resulting S3 key."
  def mark_completed(%Export{} = export, s3_key) do
    export
    |> Export.changeset(%{status: "completed", s3_key: s3_key})
    |> Repo.update()
  end

  @doc "Mark an export as failed."
  def mark_failed(%Export{} = export) do
    export
    |> Export.changeset(%{status: "failed"})
    |> Repo.update()
  end

  def delete_export(%Export{} = export) do
    # TODO: delete from S3 as well
    Repo.delete(export)
  end
end

defmodule BackendWeb.SampleController do
  use BackendWeb, :controller

  alias Backend.Samples

  def index(conn, params) do
    result = Samples.list_samples(params)

    json(conn, %{
      data: Enum.map(result.data, &sample_json/1),
      page: result.page,
      limit: result.limit,
      total: result.total
    })
  end

  def show(conn, %{"id" => id}) do
    case Samples.get_sample(id) do
      {:ok, sample} -> json(conn, %{data: sample_json(sample)})
      {:error, :not_found} -> send_resp(conn, 404, "")
    end
  end

  def create(conn, params) do
    # In a real upload, the file goes to MinIO first to get an s3_key.
    # For scaffolding, we accept the metadata directly.
    attrs = %{
      name: params["name"],
      genre: params["genre"],
      s3_key: params["s3_key"] || "samples/placeholder_#{System.system_time(:millisecond)}"
    }

    case Samples.create_sample(attrs) do
      {:ok, sample} ->
        conn |> put_status(201) |> json(%{data: sample_json(sample)})

      {:error, changeset} ->
        conn |> put_status(422) |> json(%{errors: format_errors(changeset)})
    end
  end

  def delete(conn, %{"id" => id}) do
    with {:ok, sample} <- Samples.get_sample(id),
         {:ok, _} <- Samples.delete_sample(sample) do
      send_resp(conn, 204, "")
    else
      {:error, :not_found} -> send_resp(conn, 404, "")
    end
  end

  defp sample_json(sample) do
    %{
      id: sample.id,
      name: sample.name,
      genre: sample.genre,
      s3_key: sample.s3_key,
      duration_ms: sample.duration_ms,
      inserted_at: sample.inserted_at
    }
  end

  defp format_errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, _opts} -> msg end)
  end
end

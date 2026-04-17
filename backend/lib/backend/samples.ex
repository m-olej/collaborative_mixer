defmodule Backend.Samples do
  @moduledoc "Context for managing the shared sample library."

  import Ecto.Query
  alias Backend.Repo
  alias Backend.Samples.Sample

  @doc "List samples with page-based pagination."
  def list_samples(params) do
    page = max((params["page"] || "1") |> String.to_integer(), 1)
    limit = min(max((params["limit"] || "50") |> String.to_integer(), 1), 100)
    offset = (page - 1) * limit

    samples =
      Sample
      |> limit(^limit)
      |> offset(^offset)
      |> order_by(asc: :inserted_at)
      |> Repo.all()

    total = Repo.aggregate(Sample, :count)

    %{
      data: samples,
      page: page,
      limit: limit,
      total: total
    }
  end

  def get_sample(id) do
    case Repo.get(Sample, id) do
      nil -> {:error, :not_found}
      sample -> {:ok, sample}
    end
  end

  def create_sample(attrs) do
    %Sample{}
    |> Sample.changeset(attrs)
    |> Repo.insert()
  end

  def delete_sample(%Sample{} = sample) do
    # TODO: delete from S3 as well
    Repo.delete(sample)
  end
end

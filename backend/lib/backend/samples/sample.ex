defmodule Backend.Samples.Sample do
  use Ecto.Schema
  import Ecto.Changeset

  schema "samples" do
    field :name, :string
    field :genre, :string
    field :s3_key, :string
    field :duration_ms, :integer

    timestamps(type: :utc_datetime)
  end

  @doc "Changeset for creating a sample record."
  def changeset(sample, attrs) do
    sample
    |> cast(attrs, [:name, :genre, :s3_key, :duration_ms])
    |> validate_required([:name, :s3_key])
  end
end

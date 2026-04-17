defmodule Backend.Projects.Track do
  use Ecto.Schema
  import Ecto.Changeset

  schema "tracks" do
    field :name, :string
    field :s3_key, :string
    field :position_ms, :integer, default: 0

    belongs_to :project, Backend.Projects.Project

    timestamps(type: :utc_datetime)
  end

  @doc "Changeset for creating or updating a track."
  def changeset(track, attrs) do
    track
    |> cast(attrs, [:name, :s3_key, :position_ms])
    |> validate_required([:name, :s3_key])
    |> validate_number(:position_ms, greater_than_or_equal_to: 0)
  end
end

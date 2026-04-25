defmodule Backend.Projects.Track do
  use Ecto.Schema
  import Ecto.Changeset

  schema "tracks" do
    field :name, :string
    field :s3_key, :string
    field :position_ms, :integer, default: 0
    field :lane_index, :integer, default: 0
    field :lock_version, :integer, default: 1

    belongs_to :project, Backend.Projects.Project

    timestamps(type: :utc_datetime)
  end

  @doc "Changeset for creating a track."
  def changeset(track, attrs) do
    track
    |> cast(attrs, [:name, :s3_key, :position_ms, :lane_index])
    |> validate_required([:name, :s3_key])
    |> validate_number(:position_ms, greater_than_or_equal_to: 0)
    |> validate_number(:lane_index, greater_than_or_equal_to: 0)
  end

  @doc "Changeset for updating a track with optimistic locking."
  def update_changeset(track, attrs) do
    track
    |> cast(attrs, [:name, :position_ms, :lane_index])
    |> validate_number(:position_ms, greater_than_or_equal_to: 0)
    |> validate_number(:lane_index, greater_than_or_equal_to: 0)
    |> optimistic_lock(:lock_version)
  end
end

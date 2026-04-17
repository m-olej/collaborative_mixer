defmodule Backend.Projects.Project do
  use Ecto.Schema
  import Ecto.Changeset

  schema "projects" do
    field :name, :string
    field :bpm, :integer, default: 120
    field :time_signature, :string, default: "4/4"
    field :lock_version, :integer, default: 1

    has_many :tracks, Backend.Projects.Track
    has_many :exports, Backend.Exports.Export

    timestamps(type: :utc_datetime)
  end

  @doc "Changeset for creating or updating a project."
  def changeset(project, attrs) do
    project
    |> cast(attrs, [:name, :bpm, :time_signature])
    |> validate_required([:name, :bpm])
    |> validate_number(:bpm, greater_than: 0, less_than: 999)
    |> optimistic_lock(:lock_version)
  end
end

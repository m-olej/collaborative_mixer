defmodule Backend.Exports.Export do
  use Ecto.Schema
  import Ecto.Changeset

  @statuses ~w(pending completed failed)

  schema "exports" do
    field :token, :string
    field :status, :string, default: "pending"
    field :s3_key, :string

    belongs_to :project, Backend.Projects.Project

    timestamps(type: :utc_datetime)
  end

  @doc "Changeset for creating an export record."
  def changeset(export, attrs) do
    export
    |> cast(attrs, [:token, :status, :s3_key])
    |> validate_required([:token])
    |> validate_inclusion(:status, @statuses)
    |> unique_constraint(:token)
  end
end

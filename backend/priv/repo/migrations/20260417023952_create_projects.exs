defmodule Backend.Repo.Migrations.CreateProjects do
  use Ecto.Migration

  def change do
    create table(:projects) do
      add :name, :string, null: false
      add :bpm, :integer, null: false, default: 120
      add :time_signature, :string, null: false, default: "4/4"
      add :lock_version, :integer, null: false, default: 1

      timestamps(type: :utc_datetime)
    end
  end
end

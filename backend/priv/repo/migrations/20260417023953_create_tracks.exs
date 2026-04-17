defmodule Backend.Repo.Migrations.CreateTracks do
  use Ecto.Migration

  def change do
    create table(:tracks) do
      add :name, :string, null: false
      add :s3_key, :string, null: false
      add :position_ms, :integer, null: false, default: 0

      add :project_id, references(:projects, on_delete: :delete_all), null: false

      timestamps(type: :utc_datetime)
    end

    create index(:tracks, [:project_id])
  end
end

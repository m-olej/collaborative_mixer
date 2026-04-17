defmodule Backend.Repo.Migrations.CreateExports do
  use Ecto.Migration

  def change do
    create table(:exports) do
      add :token, :string, null: false
      add :status, :string, null: false, default: "pending"
      add :s3_key, :string

      add :project_id, references(:projects, on_delete: :delete_all), null: false

      timestamps(type: :utc_datetime)
    end

    create unique_index(:exports, [:token])
    create index(:exports, [:project_id])
  end
end

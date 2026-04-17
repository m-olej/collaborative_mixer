defmodule Backend.Repo.Migrations.CreateSamples do
  use Ecto.Migration

  def change do
    create table(:samples) do
      add :name, :string, null: false
      add :genre, :string
      add :s3_key, :string, null: false
      add :duration_ms, :integer

      timestamps(type: :utc_datetime)
    end
  end
end

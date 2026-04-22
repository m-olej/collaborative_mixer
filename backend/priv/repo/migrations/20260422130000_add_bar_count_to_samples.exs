defmodule Backend.Repo.Migrations.AddBarCountToSamples do
  use Ecto.Migration

  def change do
    alter table(:samples) do
      add(:bar_count, :integer, default: 1, null: false)
    end
  end
end

defmodule Backend.Repo.Migrations.AddSampleInputHistoryAndProjectCountIn do
  use Ecto.Migration

  def change do
    alter table(:samples) do
      add(:input_history, :map)
    end

    alter table(:projects) do
      add(:count_in_note_value, :string, default: "quarter")
    end
  end
end

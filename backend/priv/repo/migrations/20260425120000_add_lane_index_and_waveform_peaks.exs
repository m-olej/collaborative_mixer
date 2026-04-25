defmodule Backend.Repo.Migrations.AddLaneIndexAndWaveformPeaks do
  use Ecto.Migration

  def change do
    alter table(:tracks) do
      add :lane_index, :integer, default: 0, null: false
      add :lock_version, :integer, default: 1, null: false
    end

    create index(:tracks, [:project_id, :lane_index])

    alter table(:samples) do
      add :waveform_peaks, {:array, :map}, default: nil
    end
  end
end

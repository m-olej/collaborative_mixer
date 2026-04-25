defmodule Backend.Samples.Sample do
  use Ecto.Schema
  import Ecto.Changeset

  schema "samples" do
    field(:name, :string)
    field(:genre, :string)
    field(:s3_key, :string)
    field(:duration_ms, :integer)
    field(:input_history, :map)
    field(:bar_count, :integer, default: 1)
    field(:waveform_peaks, {:array, :map})

    timestamps(type: :utc_datetime)
  end

  @doc "Changeset for creating a sample record."
  def changeset(sample, attrs) do
    sample
    |> cast(attrs, [
      :name,
      :genre,
      :s3_key,
      :duration_ms,
      :input_history,
      :bar_count,
      :waveform_peaks
    ])
    |> validate_required([:name, :s3_key])
    |> validate_number(:bar_count, greater_than: 0, less_than_or_equal_to: 16)
  end
end

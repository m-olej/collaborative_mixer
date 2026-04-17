defmodule BackendWeb.ExportController do
  use BackendWeb, :controller

  alias Backend.Exports

  def index(conn, %{"project_id" => project_id}) do
    exports = Exports.list_exports(project_id)
    json(conn, %{data: Enum.map(exports, &export_json/1)})
  end

  def show(conn, %{"id" => id}) do
    case Exports.get_export(id) do
      {:ok, export} -> json(conn, %{data: export_json(export)})
      {:error, :not_found} -> send_resp(conn, 404, "")
    end
  end

  def create(conn, %{"project_id" => project_id} = params) do
    token = params["token"]

    if is_nil(token) or token == "" do
      conn |> put_status(400) |> json(%{error: "token query parameter is required"})
    else
      case Exports.find_by_token(token) do
        nil ->
          {:ok, _export} = Exports.create_export(project_id, token)
          # TODO: spawn async DSP render task
          send_resp(conn, 202, "")

        %{status: "completed"} = export ->
          conn
          |> put_resp_header(
            "location",
            ~p"/api/projects/#{project_id}/exports/#{export.id}"
          )
          |> send_resp(303, "")

        %{status: _pending_or_failed} ->
          send_resp(conn, 202, "")
      end
    end
  end

  def delete(conn, %{"id" => id}) do
    with {:ok, export} <- Exports.get_export(id),
         {:ok, _} <- Exports.delete_export(export) do
      send_resp(conn, 204, "")
    else
      {:error, :not_found} -> send_resp(conn, 404, "")
    end
  end

  defp export_json(export) do
    %{
      id: export.id,
      token: export.token,
      status: export.status,
      project_id: export.project_id,
      inserted_at: export.inserted_at,
      updated_at: export.updated_at
    }
  end
end

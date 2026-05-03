defmodule BackendWeb.Router do
  use BackendWeb, :router

  pipeline :api do
    plug(:accepts, ["json"])
  end

  scope "/api", BackendWeb do
    pipe_through(:api)

    get("/ping", PingController, :index)

    resources "/projects", ProjectController, except: [:new, :edit] do
      post("/actions/merge-tracks", ProjectController, :merge_tracks)
      resources("/exports", ExportController, only: [:index, :show, :create, :delete])
      resources("/tracks", TrackController, only: [:index, :show, :create, :update, :delete])
      post("/tracks/batch-move", TrackController, :batch_move)
    end

    resources("/samples", SampleController, except: [:new, :edit, :update])
  end
end

# Phoenix - web development using obsidian

Phoenix is a web development elixir framework that implements **Server-side** Model View Controller (**MVC**) pattern.
It uses `mix`, which is a build tool of the elixir ecosystem. 

## Mix

The build tool operates on the configured **MixProject** module defined in the root `mix.exs` file.

```elixir
defmodule MyApp.MixProject do
  use Mix.Project

  def project do
    [
      app: :my_app
      version: "0.1.0",
      elixir: "~> 1.15", # elixir version
      elixirc_paths: elixirc_paths(Mix.env()), # paths used during compilation
      start_permanent: Mix.env() == :prod, # ensure that if application supervision tree terminates the whole node will too. Ignored during development
      aliases: aliases(), # load aliases from private aliases function (returning a list)
      deps: deps(), # managed dependencies based on configured deps list (private function)
      listeners: [Phoenix.CodeReloader] # phoenix specific development hot-reload listener
    ]
  end
end
```

Mix comes with prebuilt: compile, test and run tasks, but can be extended by writing custom tasks

```elixir
defmodule Mix.Tasks.Hello do
  use Mix.Task

  def run(_) do
    Mix.shell().info("Hello world")
  end
end
```

```shell
mix hello
```

This can be further extended by using the concept of aliases, which can create pipelines of tasks to run in sequential orded, or create a shorthand alias for an existing task.

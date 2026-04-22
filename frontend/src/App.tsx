import { useState, useCallback } from "react";
import { ProjectList } from "./components/ProjectList";
import { ProjectWorkspace } from "./components/ProjectWorkspace";
import type { Project } from "./types/daw";

function App() {
  const [activeProject, setActiveProject] = useState<Project | null>(null);

  const handleSelect = useCallback((project: Project) => {
    setActiveProject(project);
  }, []);

  const handleBack = useCallback(() => {
    setActiveProject(null);
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
        <h1 className="text-xl font-bold tracking-tight">Cloud DAW</h1>
        {activeProject && (
          <button
            onClick={handleBack}
            className="text-sm text-gray-400 hover:text-white"
          >
            ← Back to projects
          </button>
        )}
      </header>

      <main>
        {activeProject ? (
          <ProjectWorkspace project={activeProject} />
        ) : (
          <div className="mx-auto max-w-4xl">
            <ProjectList onSelect={handleSelect} />
          </div>
        )}
      </main>
    </div>
  );
}

export default App;


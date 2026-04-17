import { useEffect, useState, useCallback } from "react";
import { useProjectStore } from "../store/useProjectStore";
import type { Project } from "../types/daw";

/** Dashboard showing the list of projects with create functionality. */
export function ProjectList({ onSelect }: { onSelect: (p: Project) => void }) {
  const { projects, loading, error, fetchProjects, createProject } = useProjectStore();
  const [newName, setNewName] = useState("");

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    const project = await createProject(newName.trim(), 120);
    onSelect(project);
    setNewName("");
  }, [newName, createProject, onSelect]);

  return (
    <div className="flex flex-col gap-4 p-4">
      <h2 className="text-lg font-semibold text-white">Projects</h2>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          placeholder="New project name"
          className="flex-1 rounded bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          onClick={handleCreate}
          disabled={!newName.trim()}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          Create
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => onSelect(p)}
                className="w-full rounded px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-800"
              >
                {p.name}{" "}
                <span className="text-gray-500">— {p.bpm} BPM</span>
              </button>
            </li>
          ))}
          {projects.length === 0 && (
            <p className="text-sm text-gray-500">No projects yet. Create one above.</p>
          )}
        </ul>
      )}
    </div>
  );
}

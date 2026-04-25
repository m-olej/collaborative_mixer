import { useEffect, useState, useCallback } from "react";
import { useProjectStore } from "../store/useProjectStore";
import { useCollabStore } from "../store/useCollabStore";
import type { Project } from "../types/daw";

const COLOR_PRESETS = [
  "#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6",
  "#8b5cf6", "#ef4444", "#14b8a6", "#f97316", "#06b6d4",
];

/** Dashboard showing the list of projects with create functionality. */
export function ProjectList({ onSelect }: { onSelect: (p: Project) => void }) {
  const { projects, loading, error, fetchProjects, createProject } = useProjectStore();
  const { localUser, setLocalUser } = useCollabStore();
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
      {/* ── User Identity ──────────────────────────────────────────────── */}
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-300">Your Identity</h3>
        <div className="flex items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-gray-500">Username</span>
            <input
              type="text"
              value={localUser.username}
              onChange={(e) => setLocalUser({ username: e.target.value || "Anonymous" })}
              placeholder="Anonymous"
              className="w-40 rounded bg-gray-800 px-2 py-1.5 text-sm text-white placeholder-gray-500 outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-gray-500">Color</span>
            <div className="flex gap-1">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setLocalUser({ color: c })}
                  className="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110"
                  style={{
                    backgroundColor: c,
                    borderColor: localUser.color === c ? "white" : "transparent",
                  }}
                />
              ))}
            </div>
          </label>
        </div>
      </div>

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

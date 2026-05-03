import { useEffect, useState, useCallback } from "react";
import { useProjectStore } from "../store/useProjectStore";
import { useCollabStore } from "../store/useCollabStore";
import { api } from "../api/rest";
import type { Project } from "../types/daw";

const COLOR_PRESETS = [
  "#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6",
  "#8b5cf6", "#ef4444", "#14b8a6", "#f97316", "#06b6d4",
];

const clampBpm = (v: number) => Math.max(30, Math.min(300, v));

function BpmStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const step = (delta: number) => onChange(clampBpm(value + delta));
  const btnClass =
    "rounded px-1.5 py-0.5 text-[11px] font-semibold leading-none transition-colors";
  return (
    <div className="flex items-center gap-1">
      <button type="button" onClick={() => step(-5)} className={`${btnClass} bg-gray-700 text-gray-300 hover:bg-red-900/60 hover:text-red-300`}>−5</button>
      <button type="button" onClick={() => step(-1)} className={`${btnClass} bg-gray-700 text-gray-300 hover:bg-red-900/40 hover:text-red-300`}>−1</button>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!isNaN(n)) onChange(clampBpm(n));
        }}
        className="w-12 rounded bg-gray-800 px-1 py-0.5 text-center text-sm tabular-nums text-white outline-none focus:ring-1 focus:ring-indigo-500"
      />
      <button type="button" onClick={() => step(1)} className={`${btnClass} bg-gray-700 text-gray-300 hover:bg-green-900/40 hover:text-green-300`}>+1</button>
      <button type="button" onClick={() => step(5)} className={`${btnClass} bg-gray-700 text-gray-300 hover:bg-green-900/60 hover:text-green-300`}>+5</button>
    </div>
  );
}

/** Dashboard showing the list of projects with full CRUD functionality. */
export function ProjectList({ onSelect }: { onSelect: (p: Project) => void }) {
  const { projects, loading, error, fetchProjects, createProject, deleteProject } = useProjectStore();
  const updateProjectInStore = useProjectStore((s) => s.updateProject);
  const { localUser, setLocalUser } = useCollabStore();
  const [newName, setNewName] = useState("");
  const [newBpm, setNewBpm] = useState(120);

  // Editing state: which project is being edited inline
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editBpm, setEditBpm] = useState(120);
  const [editEtag, setEditEtag] = useState("");
  const [editError, setEditError] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    await createProject(newName.trim(), newBpm);
    setNewName("");
    setNewBpm(120);
  }, [newName, newBpm, createProject]);

  const handleDelete = useCallback(
    async (e: React.MouseEvent, project: Project) => {
      e.stopPropagation();
      if (!confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
      try {
        await deleteProject(project.id);
      } catch (err) {
        alert(`Failed to delete: ${(err as Error).message}`);
      }
    },
    [deleteProject],
  );

  const startEditing = useCallback(
    async (e: React.MouseEvent, project: Project) => {
      e.stopPropagation();
      setEditError("");
      try {
        const { etag } = await api.getProject(project.id);
        setEditingId(project.id);
        setEditName(project.name);
        setEditBpm(project.bpm);
        setEditEtag(etag);
      } catch {
        setEditError("Could not load project for editing.");
      }
    },
    [],
  );

  const cancelEditing = useCallback(() => {
    setEditingId(null);
    setEditError("");
  }, []);

  const saveEditing = useCallback(async () => {
    if (editingId === null) return;
    setEditSaving(true);
    setEditError("");
    try {
      await updateProjectInStore(editingId, { name: editName.trim(), bpm: editBpm }, editEtag);
      setEditingId(null);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("412")) {
        setEditError("Conflict — someone else updated this project. Please try again.");
        // Re-fetch etag
        try {
          const { etag } = await api.getProject(editingId);
          setEditEtag(etag);
        } catch { /* ignore */ }
      } else {
        setEditError(msg);
      }
    } finally {
      setEditSaving(false);
    }
  }, [editingId, editName, editBpm, editEtag, updateProjectInStore]);

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* ── User Identity ──────────────────────────────────────────────── */}
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-300">Your Identity</h3>
        <div className="flex items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-gray-500">Username</span>
            <input
              type="text"
              value={localUser.username}
              onChange={(e) => setLocalUser({ username: e.target.value })}
              onBlur={(e) => {
                if (!e.target.value.trim()) setLocalUser({ username: "Anonymous" });
              }}
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

      {/* ── Create New Project ──────────────────────────────────────────── */}
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-300">New Project</h3>
        <div className="flex items-end gap-3">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-[11px] text-gray-500">Name</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="My awesome track"
              className="rounded bg-gray-800 px-3 py-1.5 text-sm text-white placeholder-gray-500 outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-gray-500">BPM</span>
            <BpmStepper value={newBpm} onChange={setNewBpm} />
          </div>
          <button
            onClick={handleCreate}
            disabled={!newName.trim()}
            className="rounded-lg bg-indigo-600 px-5 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            Create
          </button>
        </div>
      </div>

      {/* ── Project List ─────────────────────────────────────────────── */}
      <div>
        <h2 className="mb-3 text-lg font-semibold text-white">Projects</h2>
        {error && <p className="mb-2 text-sm text-red-400">{error}</p>}

        {loading ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="text-sm text-gray-500">No projects yet. Create one above.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {projects.map((p) => (
              <li key={p.id}>
                {editingId === p.id ? (
                  /* ── Inline edit row ─────────────────────────────── */
                  <div className="flex items-center gap-2 rounded-lg border border-indigo-500/40 bg-gray-900 px-3 py-2">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveEditing();
                        if (e.key === "Escape") cancelEditing();
                      }}
                      className="flex-1 rounded bg-gray-800 px-2 py-1 text-sm text-white outline-none focus:ring-1 focus:ring-indigo-500"
                      autoFocus
                    />
                    <BpmStepper value={editBpm} onChange={setEditBpm} />
                    <button
                      onClick={saveEditing}
                      disabled={editSaving || !editName.trim()}
                      className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-40"
                    >
                      {editSaving ? "…" : "Save"}
                    </button>
                    <button
                      onClick={cancelEditing}
                      className="rounded bg-gray-700 px-3 py-1 text-xs font-medium text-gray-300 hover:bg-gray-600"
                    >
                      Cancel
                    </button>
                    {editError && (
                      <span className="text-xs text-red-400">{editError}</span>
                    )}
                  </div>
                ) : (
                  /* ── Normal row ─────────────────────────────────── */
                  <div className="group flex items-center rounded-lg px-3 py-2 hover:bg-gray-800/70">
                    <button
                      onClick={() => onSelect(p)}
                      className="flex-1 text-left text-sm text-gray-200"
                    >
                      <span className="font-medium">{p.name}</span>
                      <span className="ml-2 text-gray-500">— {p.bpm} BPM</span>
                      <span className="ml-2 text-[11px] text-gray-600">{p.time_signature}</span>
                    </button>
                    <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={(e) => startEditing(e, p)}
                        className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-gray-700 hover:text-white"
                        title="Edit project"
                      >
                        edit
                      </button>
                      <button
                        onClick={(e) => handleDelete(e, p)}
                        className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-red-900/50 hover:text-red-300"
                        title="Delete project"
                      >
                        delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

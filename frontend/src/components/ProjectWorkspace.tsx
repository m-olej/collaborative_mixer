import { useCallback, useEffect, useState } from "react";
import { useSocketStore } from "../store/useSocketStore";
import { MixerView } from "./MixerView";
import { DesignView } from "./Design/DesignView";
import { api } from "../api/rest";
import type { Project, CountInNoteValue } from "../types/daw";

type Tab = "mixer" | "design";

interface ProjectWorkspaceProps {
  project: Project;
}

/**
 * Top-level project container.
 * Owns the WebSocket connection (shared by both Mixer and Design views) and
 * renders a tab bar for switching between the two modes.
 * Also manages editable project settings (BPM, time signature, count-in note value).
 */
export function ProjectWorkspace({ project: initialProject }: ProjectWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<Tab>("mixer");
  const { connect, disconnect, connected } = useSocketStore();

  // Local mutable project state for settings editing.
  const [project, setProject] = useState<Project>(initialProject);
  const [etag, setEtag] = useState<string>("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Fetch ETag on mount so we can do optimistic-locking updates.
  useEffect(() => {
    api.getProject(initialProject.id).then(({ project: p, etag: e }) => {
      setProject(p);
      setEtag(e);
    });
  }, [initialProject.id]);

  // Single connection shared across tabs — established here so switching
  // tabs does NOT tear down and re-create the WebSocket.
  useEffect(() => {
    connect(project.id);
    return () => disconnect();
  }, [project.id, connect, disconnect]);

  // ── Settings save ─────────────────────────────────────────────────────────
  const saveSettings = useCallback(
    async (updates: Partial<Pick<Project, "name" | "bpm" | "time_signature" | "count_in_note_value">>) => {
      setSaving(true);
      try {
        const updated = await api.updateProject(project.id, updates, etag);
        setProject(updated);
        // Re-fetch etag after update
        const { etag: newEtag } = await api.getProject(project.id);
        setEtag(newEtag);
      } catch (err) {
        // On conflict, re-fetch
        const { project: p, etag: e } = await api.getProject(project.id);
        setProject(p);
        setEtag(e);
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [project.id, etag],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── Tab bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-end gap-0 border-b border-gray-800 px-4">
        <TabButton active={activeTab === "mixer"} onClick={() => setActiveTab("mixer")}>
          Mixer
        </TabButton>
        <TabButton active={activeTab === "design"} onClick={() => setActiveTab("design")}>
          Design
        </TabButton>

        {/* Settings toggle + status */}
        <div className="ml-auto flex items-center gap-3 pb-3">
          <button
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            className="rounded bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700 hover:text-white"
          >
            ⚙ Settings
          </button>
          <div
            className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-400"}`}
          />
          <span className="text-xs text-gray-400">
            {project.name} · {project.bpm} BPM · {project.time_signature}
          </span>
        </div>
      </div>

      {/* ── Settings panel ───────────────────────────────────────────────── */}
      {settingsOpen && (
        <ProjectSettings
          project={project}
          saving={saving}
          onSave={saveSettings}
        />
      )}

      {/* ── Active view ──────────────────────────────────────────────────── */}
      {activeTab === "mixer" ? (
        <MixerView project={project} />
      ) : (
        <DesignView
          projectId={project.id}
          bpm={project.bpm}
          timeSignature={project.time_signature}
          countInNoteValue={project.count_in_note_value ?? "quarter"}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectSettings — inline settings panel
// ---------------------------------------------------------------------------

interface ProjectSettingsProps {
  project: Project;
  saving: boolean;
  onSave: (updates: Partial<Pick<Project, "name" | "bpm" | "time_signature" | "count_in_note_value">>) => Promise<void>;
}

function ProjectSettings({ project, saving, onSave }: ProjectSettingsProps) {
  const [bpm, setBpm] = useState(project.bpm);
  const [timeSignature, setTimeSignature] = useState(project.time_signature);
  const [countInNoteValue, setCountInNoteValue] = useState<CountInNoteValue>(
    project.count_in_note_value ?? "quarter",
  );
  const [error, setError] = useState("");

  // Sync with parent project on change
  useEffect(() => {
    setBpm(project.bpm);
    setTimeSignature(project.time_signature);
    setCountInNoteValue(project.count_in_note_value ?? "quarter");
  }, [project]);

  const handleSave = async () => {
    setError("");
    try {
      await onSave({ bpm, time_signature: timeSignature, count_in_note_value: countInNoteValue });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    }
  };

  return (
    <div className="border-b border-gray-800 bg-gray-900/80 px-6 py-4">
      <div className="flex flex-wrap items-end gap-5">
        {/* BPM */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">
            BPM
          </span>
          <input
            type="number"
            min={30}
            max={300}
            value={bpm}
            onChange={(e) => setBpm(Math.max(30, Math.min(300, Number(e.target.value))))}
            className="w-20 rounded bg-gray-800 px-2 py-1 text-sm text-white outline-none
                       focus:ring-1 focus:ring-indigo-500"
          />
        </label>

        {/* Time Signature */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">
            Time Signature
          </span>
          <select
            value={timeSignature}
            onChange={(e) => setTimeSignature(e.target.value)}
            className="rounded bg-gray-800 px-2 py-1 text-sm text-white outline-none
                       focus:ring-1 focus:ring-indigo-500"
          >
            <option value="4/4">4/4</option>
            <option value="3/4">3/4</option>
            <option value="6/8">6/8</option>
            <option value="2/4">2/4</option>
            <option value="5/4">5/4</option>
            <option value="7/8">7/8</option>
          </select>
        </label>

        {/* Count-in note value */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">
            Count-in
          </span>
          <select
            value={countInNoteValue}
            onChange={(e) => setCountInNoteValue(e.target.value as CountInNoteValue)}
            className="rounded bg-gray-800 px-2 py-1 text-sm text-white outline-none
                       focus:ring-1 focus:ring-indigo-500"
          >
            <option value="quarter">Quarter</option>
            <option value="eighth">Eighth</option>
            <option value="sixteenth">Sixteenth</option>
          </select>
        </label>

        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white
                     hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>

        {error && (
          <span className="text-xs text-red-400">{error}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TabButton
// ---------------------------------------------------------------------------

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-5 pb-3 pt-3 text-sm font-medium border-b-2 transition-colors ${
        active
          ? "border-indigo-500 text-white"
          : "border-transparent text-gray-400 hover:text-gray-200"
      }`}
    >
      {children}
    </button>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useSocketStore } from "../store/useSocketStore";
import { useDesignViewStore } from "../store/useDesignViewStore";
import { useTimelineStore } from "../store/useTimelineStore";
import { useAudioWorklet } from "../hooks/useAudioWorklet";
import { MixerView } from "./MixerView";
import { DesignView } from "./Design/DesignView";
import { AudioVisualization, type AudioVisualizationHandle } from "./AudioVisualization";
import { CursorOverlay } from "./Collaboration/CursorOverlay";
import { HelpLegend } from "./HelpLegend";
import { api } from "../api/rest";
import type { Project, CountInNoteValue } from "../types/daw";

type Tab = "mixer" | "design";

interface ProjectWorkspaceProps {
  project: Project;
  onBack: () => void;
}

/**
 * Top-level project container.
 * Owns the WebSocket connection (shared by both Mixer and Design views) and
 * renders a tab bar for switching between the two modes.
 * Also manages editable project settings (BPM, time signature, count-in note value).
 */
export function ProjectWorkspace({ project: initialProject, onBack }: ProjectWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<Tab>("mixer");
  const { connect, disconnect, connected, setVisualizationCallback, setAudioCallback, setClearAudioCallback, pushCursorMove } = useSocketStore();
  const channel = useSocketStore((s) => s.channel);
  const mixerSyncEnabled = useDesignViewStore((s) => s.syncByView["mixer"] ?? false);
  const setSyncStore = useDesignViewStore((s) => s.setSync);
  const vizRef = useRef<AudioVisualizationHandle>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const cursorThrottleRef = useRef<number>(0);

  // AudioWorklet for mixer playback (separate from synth worklet in DesignView).
  const { init: initWorklet, feedPcm, clearBuffer, destroy: destroyWorklet } = useAudioWorklet();

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
    // Initialize AudioWorklet for mixer playback (48kHz, matches Rust engine).
    initWorklet();

    // Wire visualization callback before connecting.
    setVisualizationCallback((fft, pcm) => {
      vizRef.current?.updateVisualization(fft, pcm);
    });

    // Wire audio callback: feed PCM from server to the AudioWorklet for speaker output.
    setAudioCallback((pcm) => {
      feedPcm(pcm);
    });

    // Wire clear callback: flush ring buffer on seek/stop.
    setClearAudioCallback(() => {
      clearBuffer();
    });

    connect(project.id);
    return () => {
      disconnect();
      setVisualizationCallback(null);
      setAudioCallback(null);
      setClearAudioCallback(null);
      destroyWorklet();
    };
  }, [project.id, connect, disconnect, setVisualizationCallback, setAudioCallback, setClearAudioCallback, initWorklet, feedPcm, clearBuffer, destroyWorklet]);

  // Throttled cursor tracking.
  useEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;

    const handleMouseMove = (e: MouseEvent) => {
      const now = Date.now();
      if (now - cursorThrottleRef.current < 50) return;
      cursorThrottleRef.current = now;
      const rect = el.getBoundingClientRect();
      pushCursorMove(e.clientX - rect.left, e.clientY - rect.top, activeTab);
    };

    el.addEventListener("mousemove", handleMouseMove);
    return () => el.removeEventListener("mousemove", handleMouseMove);
  }, [pushCursorMove, activeTab]);

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

  // Forward AnalyserNode from SynthControls to AudioVisualization.
  const handleAnalyserChange = useCallback((analyser: AnalyserNode | null) => {
    vizRef.current?.setAnalyser(analyser);
  }, []);

  // Space bar for play/stop (only in mixer tab to avoid conflicts with synth keyboard).
  const { pushStartPlayback, pushStopPlayback } = useSocketStore();
  useEffect(() => {
    if (activeTab !== "mixer") return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input or textarea.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        const playing = useTimelineStore.getState().playing;
        if (playing) {
          pushStopPlayback();
        } else {
          pushStartPlayback(useTimelineStore.getState().playheadMs);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab, pushStartPlayback, pushStopPlayback]);

  return (
    <div ref={workspaceRef} className="relative flex min-h-0 flex-1 flex-col">
      {/* ── Cursor overlay ──────────────────────────────────────────── */}
      <CursorOverlay currentView={activeTab} />

      {/* ── Tab bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-end gap-0 border-b border-gray-800 px-4">
        <button
          type="button"
          onClick={onBack}
          className="mr-3 pb-3 pt-3 text-sm text-gray-400 hover:text-white"
          title="Back to project list"
        >
          ← Projects
        </button>
        <div className="mr-1 self-stretch border-r border-gray-700" />
        <TabButton active={activeTab === "mixer"} onClick={() => setActiveTab("mixer")}>
          Mixer
        </TabButton>
        <TabButton active={activeTab === "design"} onClick={() => setActiveTab("design")}>
          Design
        </TabButton>

        {/* Settings toggle + sync + status */}
        <div className="ml-auto flex items-center gap-3 pb-3">
          {activeTab === "mixer" && (
            <button
              type="button"
              onClick={setSyncStore.bind(null, "mixer", !mixerSyncEnabled)}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                mixerSyncEnabled
                  ? "bg-green-600/80 text-white hover:bg-green-500"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
              }`}
              title={mixerSyncEnabled ? "Hearing all users' audio" : "Hearing only your audio"}
            >
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${mixerSyncEnabled ? "bg-green-300" : "bg-gray-600"}`} />
              {mixerSyncEnabled ? "Sync On" : "Sync Off"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            className="rounded bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700 hover:text-white"
          >
            ⚙ Settings
          </button>
          <HelpLegend />
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
          key={project.id} // reset internal state when switching projects
          saving={saving}
          onSave={saveSettings}
        />
      )}

      {/* ── Audio Visualization (always visible) ─────────────────────────── */}
      <AudioVisualization ref={vizRef} />

      {/* ── Active view ──────────────────────────────────────────────────── */}
      {activeTab === "mixer" ? (
        <MixerView project={project} />
      ) : (
        <DesignView
          projectId={project.id}
          bpm={project.bpm}
          timeSignature={project.time_signature}
          countInNoteValue={project.count_in_note_value ?? "quarter"}
          onAnalyserChange={handleAnalyserChange}
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
  // useEffect(() => {
  //   setBpm(project.bpm);
  //   setTimeSignature(project.time_signature);
  //   setCountInNoteValue(project.count_in_note_value ?? "quarter");
  // }, [project]);

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

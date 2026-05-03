import { useCallback, useEffect, useRef, useState } from "react";
import { SynthControls } from "../SynthControls";
import { useSocketStore } from "../../store/useSocketStore";
import { useAudioWorklet } from "../../hooks/useAudioWorklet";
import { useCollabStore } from "../../store/useCollabStore";
import { useDesignViewStore } from "../../store/useDesignViewStore";
import { SampleRecorder, type SampleRecorderHandle } from "./SampleRecorder";
import { PianoRoll } from "./PianoRoll";
import type { NoteEvent } from "../Keyboard";
import type { CountInNoteValue, LocalSample } from "../../types/daw";

interface DesignViewProps {
  projectId: number;
  bpm: number;
  timeSignature: string;
  countInNoteValue: CountInNoteValue;
}

interface SaveState {
  status: "idle" | "saving" | "success" | "error";
  message: string;
}

/**
 * Design view — sample design workspace.
 *
 * Layout:
 *  ┌──────────────────────────┬─────────────────────────┐
 *  │  SynthControls           │  Sample Recorder        │
 *  │  (oscillator, filter,    │  - Record / Stop        │
 *  │   EQ, amp/drive,         │  - Count-in settings    │
 *  │   spectrum, oscilloscope)│  - PianoRoll            │
 *  │                          │  - Playback button      │
 *  │  Keyboard                │  - Save to Library      │
 *  └──────────────────────────┴─────────────────────────┘
 */
export function DesignView({ projectId, bpm, timeSignature, countInNoteValue: initialCountIn }: DesignViewProps) {
  const channel = useSocketStore((s) => s.channel);
  const { feedPcm } = useAudioWorklet();

  // ── Design view identity ──────────────────────────────────────────────────
  const localUsername = useCollabStore((s) => s.localUser.username);
  const remoteUsers = useCollabStore((s) => s.remoteUsers);
  const myViewId = `design:${localUsername}`;
  const activeViewId = useDesignViewStore((s) => s.activeViewId);
  const setActiveView = useDesignViewStore((s) => s.setActiveView);
  const ensureView = useDesignViewStore((s) => s.ensureView);
  const designViews = useDesignViewStore((s) => s.designViews);

  // Ensure own view exists and is active on mount.
  useEffect(() => {
    ensureView(myViewId);
    if (!activeViewId) setActiveView(myViewId);
  }, [myViewId, activeViewId, ensureView, setActiveView]);

  const currentViewId = activeViewId || myViewId;
  const isOwnView = currentViewId === myViewId;

  // ── Audio sync toggle ─────────────────────────────────────────────────────
  const syncEnabled = useDesignViewStore((s) => s.syncByView[myViewId] ?? false);
  const setSync = useDesignViewStore((s) => s.setSync);

  const handleSyncToggle = useCallback(() => {
    const next = !syncEnabled;
    setSync(myViewId, next);
    channel?.push("set_sync", { view_id: myViewId, enabled: next });
  }, [syncEnabled, setSync, myViewId, channel]);

  // ── Local sample state (lifted from SampleRecorder for PianoRoll access) ──
  const [localSample, setLocalSample] = useState<LocalSample | null>(null);
  const [countInNoteValue, setCountInNoteValue] = useState<CountInNoteValue>(initialCountIn);
  const [barCount, setBarCount] = useState(1);

  // ── Save to library state ─────────────────────────────────────────────────
  const [sampleName, setSampleName] = useState("");
  const [genre, setGenre] = useState("");
  const [saveState, setSaveState] = useState<SaveState>({
    status: "idle",
    message: "",
  });

  // ── Recorder ref for note event forwarding ─────────────────────────────
  const recorderRef = useRef<SampleRecorderHandle>(null);

  // ── Connect keyboard to recorder ──────────────────────────────────────
  const handleNoteOn = useCallback((event: NoteEvent) => {
    recorderRef.current?.noteOn(event);
  }, []);

  const handleNoteOff = useCallback((event: NoteEvent) => {
    recorderRef.current?.noteOff(event);
  }, []);

  // ── Save to library ───────────────────────────────────────────────────────
  const handleSave = useCallback(() => {
    if (!channel || !sampleName.trim() || !localSample) return;

    setSaveState({ status: "saving", message: "" });

    channel
      .push("save_sample", {
        name: sampleName.trim(),
        genre: genre.trim() || null,
        input_history: localSample.inputHistory,
        bar_duration_ms: localSample.totalDurationMs,
        bar_count: localSample.barCount,
      })
      .receive("ok", (resp: { sample_id: number; name: string }) => {
        setSaveState({
          status: "success",
          message: `"${resp.name}" saved to library.`,
        });
        setSampleName("");
        setGenre("");
      })
      .receive("error", (err: { errors: Record<string, string[]> }) => {
        const msg =
          Object.values(err.errors ?? {}).flat().join(", ") || "Save failed.";
        setSaveState({ status: "error", message: msg });
      });
  }, [channel, sampleName, genre, localSample]);

  return (
    <div className="flex flex-col gap-4 p-6" style={{ maxWidth: "1400px", margin: "0 auto" }}>
      {/* ── Design View Tab Bar ──────────────────────────────────────── */}
      <div className="flex items-center gap-1 rounded-lg bg-gray-900 px-2 py-1">
        <DesignTab
          label={localUsername}
          viewId={myViewId}
          active={currentViewId === myViewId}
          isOwn
          onClick={() => setActiveView(myViewId)}
        />
        {Object.keys(designViews)
          .filter((vid) => vid !== myViewId && vid.startsWith("design:"))
          .map((vid) => {
            const uname = vid.replace("design:", "");
            const remote = remoteUsers[uname];
            return (
              <DesignTab
                key={vid}
                label={uname}
                viewId={vid}
                active={currentViewId === vid}
                color={remote?.color}
                onClick={() => setActiveView(vid)}
              />
            );
          })}

        {/* Sync toggle */}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={handleSyncToggle}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
              syncEnabled
                ? "bg-green-600/80 text-white hover:bg-green-500"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
            }`}
            title={syncEnabled ? "Hearing all users' audio — click to hear only your own" : "Hearing only your audio — click to hear everyone"}
          >
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${syncEnabled ? "bg-green-300" : "bg-gray-600"}`} />
            {syncEnabled ? "Sync On" : "Sync Off"}
          </button>
        </div>
      </div>

      {!isOwnView && (
        <div className="rounded bg-yellow-900/30 px-3 py-1.5 text-xs text-yellow-400">
          Viewing <strong>{currentViewId.replace("design:", "")}</strong>'s design — read-only
        </div>
      )}

      <div className="flex gap-6">
      {/* ── Left: synthesizer controls ──────────────────────────────────── */}
      <div className="min-w-0 flex-1">
        <SynthControls
          projectId={projectId}
          viewId={currentViewId}
          onNoteOn={isOwnView ? handleNoteOn : undefined}
          onNoteOff={isOwnView ? handleNoteOff : undefined}
        />
      </div>

      {/* ── Right: sample design panel ──────────────────────────────────── */}
      <div className="flex w-[650px] shrink-0 flex-col gap-5 rounded-xl bg-gray-900 p-5">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-widest text-indigo-400">
            Sample Design
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            Record a bar of keyboard input. The server renders polyphonic audio.
          </p>
        </div>

        {/* ── Recorder ───────────────────────────────────────────────── */}
        <SampleRecorder
          ref={recorderRef}
          bpm={bpm}
          timeSignature={timeSignature}
          countInNoteValue={countInNoteValue}
          onCountInNoteValueChange={setCountInNoteValue}
          localSample={localSample}
          onLocalSampleChange={setLocalSample}
          barCount={barCount}
          onBarCountChange={setBarCount}
          viewId={currentViewId}
        />

        {/* ── Piano Roll ─────────────────────────────────────────────── */}
        <PianoRoll
          localSample={localSample}
          timeSignature={timeSignature}
          countInNoteValue={countInNoteValue}
          feedPcm={feedPcm}
          barCount={barCount}
        />

        {/* ── Save to Library ────────────────────────────────────────── */}
        {localSample && (
          <div className="flex flex-col gap-3 border-t border-gray-800 pt-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">
              Save to Library
            </h3>

            <div className="flex gap-2">
              <input
                type="text"
                value={sampleName}
                onChange={(e) => setSampleName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
                placeholder="Sample name"
                maxLength={100}
                className="flex-1 rounded bg-gray-800 px-3 py-1.5 text-sm text-white
                           placeholder-gray-600 outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <input
                type="text"
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                placeholder="Genre"
                maxLength={50}
                className="w-28 rounded bg-gray-800 px-3 py-1.5 text-sm text-white
                           placeholder-gray-600 outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button
                type="button"
                onClick={handleSave}
                disabled={!channel || !sampleName.trim() || saveState.status === "saving"}
                className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white
                           hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saveState.status === "saving" ? "Saving…" : "Save"}
              </button>
            </div>

            {saveState.status === "success" && (
              <p className="rounded bg-green-900/40 px-3 py-2 text-xs text-green-400">
                ✓ {saveState.message}
              </p>
            )}
            {saveState.status === "error" && (
              <p className="rounded bg-red-900/40 px-3 py-2 text-xs text-red-400">
                ✗ {saveState.message}
              </p>
            )}
          </div>
        )}

        {!channel && (
          <p className="text-xs text-gray-600">
            Connect to a project session to enable recording.
          </p>
        )}

        {/* ── Guidance ───────────────────────────────────────────────── */}
        <div className="mt-auto rounded bg-gray-800/60 p-3 text-[11px] text-gray-500">
          <p className="font-medium text-gray-400">Workflow</p>
          <ol className="mt-1 list-decimal pl-4 leading-5">
            <li>Dial in your synth sound and click <em>Render Sound</em> to preview.</li>
            <li>Click <em>Record</em> — a count-in metronome plays first.</li>
            <li>Play notes on the keyboard during the bar.</li>
            <li>The server renders your performance polyphonically.</li>
            <li>Review in the piano roll, then <em>Save</em> to the library.</li>
          </ol>
        </div>
      </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DesignTab — individual tab in the design view tab bar
// ---------------------------------------------------------------------------

function DesignTab({
  label,
  active,
  isOwn,
  color,
  onClick,
}: {
  label: string;
  viewId: string;
  active: boolean;
  isOwn?: boolean;
  color?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-indigo-600 text-white"
          : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
      }`}
    >
      {!isOwn && (
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: color ?? "#888" }}
        />
      )}
      {isOwn ? "My Design" : label}
    </button>
  )
}

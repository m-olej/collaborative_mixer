/**
 * SampleRecorder — Recording workflow for the sample design view.
 *
 * State machine: idle → count-in → recording → rendering → done
 *
 * During recording, keyboard note events are captured with timestamps
 * relative to the bar start. After the bar completes, the note events
 * are sent to the server for polyphonic rendering via concurrent Elixir
 * Tasks + Rust DSP NIFs.
 *
 * The rendered audio and input history are stored locally in component
 * state. Re-recording wipes the previous sample.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useAudioWorklet } from "../../hooks/useAudioWorklet";
import { useMetronome } from "../../hooks/useMetronome";
import { useSocketStore } from "../../store/useSocketStore";
import type { NoteEvent } from "../Keyboard";
import type {
  CountInNoteValue,
  LocalSample,
  RecordedNote,
  RecordingPhase,
} from "../../types/daw";
import { barDurationMs } from "../../types/daw";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SampleRecorderProps {
  bpm: number;
  timeSignature: string;
  countInNoteValue: CountInNoteValue;
  onCountInNoteValueChange: (v: CountInNoteValue) => void;
  /** The latest recorded local sample (lifted to parent for PianoRoll). */
  localSample: LocalSample | null;
  onLocalSampleChange: (s: LocalSample | null) => void;
  /** Number of bars to record. */
  barCount: number;
  onBarCountChange: (n: number) => void;
}

/** Handle exposed by SampleRecorder via forwardRef. */
export interface SampleRecorderHandle {
  noteOn: (event: NoteEvent) => void;
  noteOff: (event: NoteEvent) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SampleRecorder = forwardRef<SampleRecorderHandle, SampleRecorderProps>(
  function SampleRecorder(
    {
      bpm,
      timeSignature,
      countInNoteValue,
      onCountInNoteValueChange,
      localSample,
      onLocalSampleChange,
      barCount,
      onBarCountChange,
    },
    ref,
  ) {
  const channel = useSocketStore((s) => s.channel);
  const { init: initWorklet, feedPcm, destroy: destroyWorklet } = useAudioWorklet();
  const { playCountIn, abort: abortMetronome } = useMetronome();

  const [phase, setPhaseState] = useState<RecordingPhase>("idle");
  const phaseRef = useRef<RecordingPhase>("idle");
  const notesRef = useRef<RecordedNote[]>([]);
  const recordStartRef = useRef<number>(0);
  const barTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setPhase = useCallback((p: RecordingPhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  // ── AudioWorklet for metronome + playback ─────────────────────────────────
  useEffect(() => {
    initWorklet();
    return () => destroyWorklet();
  }, [initWorklet, destroyWorklet]);

  // ── Listen for bar_audio response from server ─────────────────────────────
  useEffect(() => {
    if (!channel) return;
    const ref = channel.on("bar_audio", (payload: unknown) => {
      if (!(payload instanceof ArrayBuffer)) return;
      const fft = new Uint8Array(payload, 4, 512);
      const pcm = new Float32Array(payload, 516);

      const totalMs = barDurationMs(bpm, timeSignature) * barCount;
      const sample: LocalSample = {
        inputHistory: notesRef.current,
        pcm: new Float32Array(pcm), // copy so the buffer isn't detached
        fft: new Uint8Array(fft),
        totalDurationMs: totalMs,
        barCount: barCount,
      };
      onLocalSampleChange(sample);
      setPhase("done");
    });
    return () => channel.off("bar_audio", ref);
  }, [channel, bpm, timeSignature, barCount, onLocalSampleChange]);

  // ── Bar / total duration ────────────────────────────────────────────────────
  const singleBarMs = barDurationMs(bpm, timeSignature);
  const totalMs = singleBarMs * barCount;

  // ── Record ────────────────────────────────────────────────────────────────
  const handleRecord = useCallback(async () => {
    if (!channel) return;

    // Wipe previous sample
    notesRef.current = [];
    onLocalSampleChange(null);
    setPhase("count-in");

    // Count-in metronome
    await playCountIn(feedPcm, { bpm, timeSignature, countInNoteValue });

    // Start recording
    setPhase("recording");
    recordStartRef.current = performance.now();

    // Auto-stop after total duration (barCount bars)
    barTimerRef.current = setTimeout(() => {
      finishRecording();
    }, totalMs);
  }, [channel, bpm, timeSignature, countInNoteValue, totalMs, feedPcm, playCountIn, onLocalSampleChange]);

  // ── Finish recording → send to server ─────────────────────────────────────
  const finishRecording = useCallback(() => {
    if (barTimerRef.current) {
      clearTimeout(barTimerRef.current);
      barTimerRef.current = null;
    }

    // Close any notes that are still held
    const elapsed = performance.now() - recordStartRef.current;
    for (const note of notesRef.current) {
      if (note.end_ms === undefined || note.end_ms === null) {
        (note as RecordedNote).end_ms = Math.min(elapsed, totalMs);
      }
    }

    if (notesRef.current.length === 0) {
      setPhase("idle");
      return;
    }

    setPhase("rendering");

    // Send note events to server for polyphonic render.
    // bar_duration_ms is the TOTAL duration (all bars combined).
    channel?.push("render_bar", {
      notes: notesRef.current,
      bar_duration_ms: totalMs,
    });
  }, [channel, totalMs]);

  // ── Stop (abort) ──────────────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    abortMetronome();
    if (barTimerRef.current) {
      clearTimeout(barTimerRef.current);
      barTimerRef.current = null;
    }
    setPhase("idle");
  }, [abortMetronome]);

  // Expose note handlers to parent via ref
  useImperativeHandle(ref, () => ({
    noteOn: (event: NoteEvent) => {
      if (phaseRef.current !== "recording") return;
      const elapsed = performance.now() - recordStartRef.current;
      notesRef.current.push({
        midi: event.midi,
        note: event.note,
        frequency: event.frequency,
        start_ms: Math.min(elapsed, totalMs),
        end_ms: totalMs,
      });
    },
    noteOff: (event: NoteEvent) => {
      if (phaseRef.current !== "recording") return;
      const elapsed = performance.now() - recordStartRef.current;
      for (let i = notesRef.current.length - 1; i >= 0; i--) {
        const n = notesRef.current[i];
        if (n.midi === event.midi && n.end_ms === totalMs) {
          n.end_ms = Math.min(elapsed, totalMs);
          break;
        }
      }
    },
  }), [totalMs]);

  // ── Playback of rendered sample ───────────────────────────────────────────
  const handlePlayback = useCallback(() => {
    if (!localSample) return;
    feedPcm(localSample.pcm);
  }, [localSample, feedPcm]);

  // ── Status label ──────────────────────────────────────────────────────────
  const phaseLabel: Record<RecordingPhase, string> = {
    idle: "Ready to record",
    "count-in": "Count-in…",
    recording: "Recording…",
    rendering: "Rendering…",
    done: "Sample ready",
  };

  return (
    <div className="flex flex-col gap-3">
      {/* ── Bar info ──────────────────────────────────────────────────── */}
      <div className="text-xs text-gray-500">
        {timeSignature} · {bpm} BPM · {barCount} bar{barCount > 1 ? "s" : ""} = {(totalMs / 1000).toFixed(2)}s
      </div>

      {/* ── Recording settings ────────────────────────────────────────── */}
      <div className="flex gap-4">
        {/* Bar count selector */}
        <div className="flex flex-col gap-0.5">
          <label className="text-[11px] text-gray-400">Bars</label>
          <select
            value={barCount}
            onChange={(e) => onBarCountChange(Number(e.target.value))}
            disabled={phase !== "idle" && phase !== "done"}
            className="rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-100"
          >
            {[1, 2, 3, 4, 6, 8].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>

        {/* Count-in note value selector */}
        <div className="flex flex-col gap-0.5">
          <label className="text-[11px] text-gray-400">Count-in grid</label>
          <select
            value={countInNoteValue}
            onChange={(e) => onCountInNoteValueChange(e.target.value as CountInNoteValue)}
            disabled={phase !== "idle" && phase !== "done"}
            className="rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-100"
          >
            <option value="quarter">Quarter notes</option>
            <option value="eighth">Eighth notes</option>
            <option value="sixteenth">Sixteenth notes</option>
          </select>
        </div>
      </div>

      {/* ── Status ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <div
          className={`h-2 w-2 rounded-full ${
            phase === "recording"
              ? "animate-pulse bg-red-500"
              : phase === "count-in"
                ? "animate-pulse bg-yellow-400"
                : phase === "rendering"
                  ? "animate-pulse bg-blue-400"
                  : phase === "done"
                    ? "bg-green-500"
                    : "bg-gray-600"
          }`}
        />
        <span className="text-xs text-gray-400">{phaseLabel[phase]}</span>
      </div>

      {/* ── Buttons ───────────────────────────────────────────────────── */}
      <div className="flex gap-2">
        {phase === "idle" || phase === "done" ? (
          <button
            type="button"
            onClick={handleRecord}
            disabled={!channel}
            className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white
                       hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {localSample ? "Re-record" : "Record"}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleStop}
            className="flex-1 rounded-lg bg-gray-600 px-4 py-2 text-sm font-medium text-white
                       hover:bg-gray-500"
          >
            Stop
          </button>
        )}

        {localSample && (phase === "done" || phase === "idle") && (
          <button
            type="button"
            onClick={handlePlayback}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white
                       hover:bg-indigo-500"
          >
            ▶ Play
          </button>
        )}
      </div>
    </div>
  );
  },
);

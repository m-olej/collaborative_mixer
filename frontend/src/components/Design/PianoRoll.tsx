/**
 * PianoRoll — Canvas-based visualization of recorded note events.
 *
 * Layout:
 *  - Vertical axis: MIDI notes (C3–B4) stacked by pitch, labels on the left.
 *  - Horizontal axis: time within the bar (0 → bar duration).
 *  - Each note is drawn as a colored rectangle from start_ms to end_ms.
 *  - Vertical grid lines at count-in note value intervals.
 *  - Playback button at the bottom.
 */

import { useCallback, useEffect, useRef } from "react";
import type { CountInNoteValue, LocalSample } from "../../types/daw";
import { clicksPerBar } from "../../types/daw";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** MIDI range displayed (C3 = 48 to B4 = 71, inclusive). */
const MIDI_MIN = 48;
const MIDI_MAX = 71;
const NUM_ROWS = MIDI_MAX - MIDI_MIN + 1; // 24 rows

const NOTE_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/** Get the note name + octave from a MIDI number. */
function midiToNoteName(midi: number): string {
  const name = NOTE_NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

/** Check if a MIDI note is a black key (sharp/flat). */
function isBlackKey(midi: number): boolean {
  const pc = midi % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PianoRollProps {
  localSample: LocalSample | null;
  timeSignature: string;
  countInNoteValue: CountInNoteValue;
  /** Feeds PCM to AudioWorklet for playback. */
  feedPcm: (pcm: Float32Array) => void;
  /** Number of bars (for grid drawing when no sample recorded yet). */
  barCount: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const LABEL_WIDTH = 36;
const CANVAS_WIDTH = 600;
const ROW_HEIGHT = 16;
const CANVAS_HEIGHT = NUM_ROWS * ROW_HEIGHT;

export function PianoRoll({
  localSample,
  timeSignature,
  countInNoteValue,
  feedPcm,
  barCount,
}: PianoRollProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── Draw ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const effectiveBarCount = localSample?.barCount ?? barCount;
    const W = canvas.width;
    const H = canvas.height;
    const gridW = W - LABEL_WIDTH;

    // Clear
    ctx.clearRect(0, 0, W, H);

    // ── Row backgrounds (alternating, black keys darker) ─────────────────
    for (let row = 0; row < NUM_ROWS; row++) {
      const midi = MIDI_MAX - row; // top = highest pitch
      const y = row * ROW_HEIGHT;

      if (isBlackKey(midi)) {
        ctx.fillStyle = "#1a1a2e";
      } else {
        ctx.fillStyle = row % 2 === 0 ? "#111827" : "#0f172a";
      }
      ctx.fillRect(LABEL_WIDTH, y, gridW, ROW_HEIGHT);

      // Horizontal line
      ctx.strokeStyle = "#1f2937";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(LABEL_WIDTH, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    // Label background
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, LABEL_WIDTH, H);
    // Draw labels
    for (let row = 0; row < NUM_ROWS; row++) {
      const midi = MIDI_MAX - row;
      const y = row * ROW_HEIGHT;
      ctx.fillStyle = isBlackKey(midi) ? "#6b7280" : "#9ca3af";
      ctx.font = "9px monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(midiToNoteName(midi), LABEL_WIDTH - 4, y + ROW_HEIGHT / 2);
    }

    // ── Subdivision grid lines (per bar) ─────────────────────────────────
    const divisionsPerBar = clicksPerBar(timeSignature, countInNoteValue);
    const totalDivisions = divisionsPerBar * effectiveBarCount;
    ctx.strokeStyle = "#374151";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= totalDivisions; i++) {
      const x = LABEL_WIDTH + (i / totalDivisions) * gridW;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    // ── Beat lines (thicker, per bar) ────────────────────────────────────
    const beatsPerBar = clicksPerBar(timeSignature, "quarter");
    const totalBeats = beatsPerBar * effectiveBarCount;
    ctx.strokeStyle = "#4b5563";
    ctx.lineWidth = 1;
    for (let i = 0; i <= totalBeats; i++) {
      const x = LABEL_WIDTH + (i / totalBeats) * gridW;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    // ── Bar boundary lines (thick, highlighted) ──────────────────────────
    if (effectiveBarCount > 1) {
      ctx.strokeStyle = "#818cf8"; // indigo-400
      ctx.lineWidth = 2;
      for (let b = 1; b < effectiveBarCount; b++) {
        const x = LABEL_WIDTH + (b / effectiveBarCount) * gridW;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
    }

    // ── Note rectangles ──────────────────────────────────────────────────
    if (localSample && localSample.inputHistory.length > 0) {
      const totalMs = localSample.totalDurationMs;

      for (const note of localSample.inputHistory) {
        if (note.midi < MIDI_MIN || note.midi > MIDI_MAX) continue;

        const row = MIDI_MAX - note.midi;
        const y = row * ROW_HEIGHT + 1;
        const h = ROW_HEIGHT - 2;
        const x = LABEL_WIDTH + (note.start_ms / totalMs) * gridW;
        const w = Math.max(((note.end_ms - note.start_ms) / totalMs) * gridW, 2);

        // Color by pitch class
        const hue = ((note.midi - MIDI_MIN) / NUM_ROWS) * 240;
        ctx.fillStyle = `hsla(${hue}, 70%, 55%, 0.85)`;
        ctx.fillRect(x, y, w, h);

        // Border
        ctx.strokeStyle = `hsla(${hue}, 70%, 40%, 1)`;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x, y, w, h);
      }
    }
  }, [localSample, timeSignature, countInNoteValue, barCount]);

  // ── Playback ──────────────────────────────────────────────────────────────
  const handlePlay = useCallback(() => {
    if (!localSample) return;
    feedPcm(localSample.pcm);
  }, [localSample, feedPcm]);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">
        Piano Roll
      </h3>

      <div className="overflow-x-auto rounded bg-gray-950">
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          style={{ imageRendering: "pixelated" }}
        />
      </div>
      {!localSample && (
        <p className="text-xs text-gray-600">
          Record a bar to see the note visualization here.
        </p>
      )}
    </div>
  );
}

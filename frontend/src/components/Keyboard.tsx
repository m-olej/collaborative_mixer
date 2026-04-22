/**
 * Keyboard — Interactive piano keyboard with QWERTY key bindings.
 *
 * Maps two octaves of a standard chromatic scale (C3–B4) to QWERTY keys
 * using the common DAW keyboard layout. A = 440 Hz (A4).
 *
 * Lower octave (C3–B3):  Z S X D C V G B H N J M
 * Upper octave (C4–B4):  Q 2 W 3 E R 5 T 6 Y 7 U
 *
 * Supports both keyboard (keydown/keyup) and mouse (mousedown/mouseup/leave)
 * input for note-on and note-off events.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Note / frequency mapping
// ---------------------------------------------------------------------------

export interface NoteEvent {
  note: string;
  frequency: number;
  midi: number;
}

/** MIDI note number to frequency (A4 = 440 Hz, MIDI 69). */
function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

interface KeyDef {
  key: string;       // keyboard key (lowercase)
  note: string;      // note name
  midi: number;      // MIDI note number
  isBlack: boolean;  // sharp/flat
}

/** Lower octave: C3 (MIDI 48) to B3 (MIDI 59) */
const LOWER_OCTAVE: KeyDef[] = [
  { key: "z", note: "C3",  midi: 48, isBlack: false },
  { key: "s", note: "C#3", midi: 49, isBlack: true },
  { key: "x", note: "D3",  midi: 50, isBlack: false },
  { key: "d", note: "D#3", midi: 51, isBlack: true },
  { key: "c", note: "E3",  midi: 52, isBlack: false },
  { key: "v", note: "F3",  midi: 53, isBlack: false },
  { key: "g", note: "F#3", midi: 54, isBlack: true },
  { key: "b", note: "G3",  midi: 55, isBlack: false },
  { key: "h", note: "G#3", midi: 56, isBlack: true },
  { key: "n", note: "A3",  midi: 57, isBlack: false },
  { key: "j", note: "A#3", midi: 58, isBlack: true },
  { key: "m", note: "B3",  midi: 59, isBlack: false },
];

/** Upper octave: C4 (MIDI 60) to B4 (MIDI 71) */
const UPPER_OCTAVE: KeyDef[] = [
  { key: "q", note: "C4",  midi: 60, isBlack: false },
  { key: "2", note: "C#4", midi: 61, isBlack: true },
  { key: "w", note: "D4",  midi: 62, isBlack: false },
  { key: "3", note: "D#4", midi: 63, isBlack: true },
  { key: "e", note: "E4",  midi: 64, isBlack: false },
  { key: "r", note: "F4",  midi: 65, isBlack: false },
  { key: "5", note: "F#4", midi: 66, isBlack: true },
  { key: "t", note: "G4",  midi: 67, isBlack: false },
  { key: "6", note: "G#4", midi: 68, isBlack: true },
  { key: "y", note: "A4",  midi: 69, isBlack: false },
  { key: "7", note: "A#4", midi: 70, isBlack: true },
  { key: "u", note: "B4",  midi: 71, isBlack: false },
];

const ALL_KEYS = [...LOWER_OCTAVE, ...UPPER_OCTAVE];

/** Lookup map: keyboard key → KeyDef */
const KEY_MAP = new Map<string, KeyDef>(ALL_KEYS.map((k) => [k.key, k]));

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface KeyboardProps {
  onNoteOn: (event: NoteEvent) => void;
  onNoteOff: (event: NoteEvent) => void;
}

function makeNoteEvent(def: KeyDef): NoteEvent {
  return { note: def.note, frequency: midiToFreq(def.midi), midi: def.midi };
}

export function Keyboard({ onNoteOn, onNoteOff }: KeyboardProps) {
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());
  const onNoteOnRef = useRef(onNoteOn);
  const onNoteOffRef = useRef(onNoteOff);
  onNoteOnRef.current = onNoteOn;
  onNoteOffRef.current = onNoteOff;

  // Track which MIDI notes are held via mouse (for global mouseUp cleanup)
  const mousePressedRef = useRef<Set<number>>(new Set());

  // ── Keyboard handlers ───────────────────────────────────────────────────

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.repeat) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;

    const key = e.key.toLowerCase();
    const def = KEY_MAP.get(key);
    if (!def) return;

    e.preventDefault();
    setActiveKeys((prev) => new Set(prev).add(key));
    onNoteOnRef.current(makeNoteEvent(def));
  }, []);

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    const def = KEY_MAP.get(key);
    if (!def) return;

    setActiveKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    onNoteOffRef.current(makeNoteEvent(def));
  }, []);

  // ── Mouse handlers ─────────────────────────────────────────────────────

  const handleMouseDown = useCallback((def: KeyDef) => {
    mousePressedRef.current.add(def.midi);
    setActiveKeys((prev) => new Set(prev).add(def.key));
    onNoteOnRef.current(makeNoteEvent(def));
  }, []);

  const handleMouseUpOrLeave = useCallback((def: KeyDef) => {
    if (!mousePressedRef.current.has(def.midi)) return;
    mousePressedRef.current.delete(def.midi);
    setActiveKeys((prev) => {
      const next = new Set(prev);
      next.delete(def.key);
      return next;
    });
    onNoteOffRef.current(makeNoteEvent(def));
  }, []);

  // Global mouseup releases all mouse-pressed notes (handles mouse leaving the keyboard area)
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      for (const midi of mousePressedRef.current) {
        const def = ALL_KEYS.find((k) => k.midi === midi);
        if (def) {
          setActiveKeys((prev) => {
            const next = new Set(prev);
            next.delete(def.key);
            return next;
          });
          onNoteOffRef.current(makeNoteEvent(def));
        }
      }
      mousePressedRef.current.clear();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [handleKeyDown, handleKeyUp]);

  return (
    <div className="rounded-lg bg-gray-800/50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">
          Keyboard
        </h3>
        <span className="text-[10px] text-gray-600">
          Z–M = C3–B3 &nbsp;|&nbsp; Q–U = C4–B4
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <OctaveRow
          keys={UPPER_OCTAVE}
          activeKeys={activeKeys}
          onMouseDown={handleMouseDown}
          onMouseUpOrLeave={handleMouseUpOrLeave}
          label="C4–B4"
        />
        <OctaveRow
          keys={LOWER_OCTAVE}
          activeKeys={activeKeys}
          onMouseDown={handleMouseDown}
          onMouseUpOrLeave={handleMouseUpOrLeave}
          label="C3–B3"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OctaveRow
// ---------------------------------------------------------------------------

function OctaveRow({
  keys,
  activeKeys,
  onMouseDown,
  onMouseUpOrLeave,
  label,
}: {
  keys: KeyDef[];
  activeKeys: Set<string>;
  onMouseDown: (def: KeyDef) => void;
  onMouseUpOrLeave: (def: KeyDef) => void;
  label: string;
}) {
  return (
    <div className="flex items-end gap-px">
      <span className="mr-1 self-center text-[9px] text-gray-600">{label}</span>
      {keys.map((def) => {
        const isActive = activeKeys.has(def.key);
        const isBlack = def.isBlack;

        return (
          <button
            key={def.midi}
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onMouseDown(def);
            }}
            onMouseUp={() => onMouseUpOrLeave(def)}
            onMouseLeave={() => onMouseUpOrLeave(def)}
            className={`
              flex flex-col items-center justify-end rounded-b pb-0.5 text-center
              transition-colors duration-75 select-none
              ${isBlack
                ? `h-8 w-6 ${isActive ? "bg-indigo-500" : "bg-gray-950 hover:bg-gray-800"} text-gray-400`
                : `h-10 w-8 ${isActive ? "bg-indigo-400 text-gray-900" : "bg-gray-200 hover:bg-gray-300 text-gray-700"}`
              }
            `}
          >
            <span className="text-[8px] leading-none font-mono">
              {def.key.toUpperCase()}
            </span>
            <span className="text-[7px] leading-none opacity-60">
              {def.note}
            </span>
          </button>
        );
      })}
    </div>
  );
}

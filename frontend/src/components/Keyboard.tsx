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
import { useCollabStore } from "../store/useCollabStore";

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

/** Lower octave template: C to B, 12 semitones */
const LOWER_KEYS = ["z", "s", "x", "d", "c", "v", "g", "b", "h", "n", "j", "m"];
const UPPER_KEYS = ["q", "2", "w", "3", "e", "r", "5", "t", "6", "y", "7", "u"];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const IS_BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];

/** Build two octaves of KeyDefs at a given base octave (e.g. 3 → C3–B4). */
function buildKeys(baseOctave: number): { lower: KeyDef[]; upper: KeyDef[]; all: KeyDef[] } {
  const baseMidi = (baseOctave + 1) * 12; // C3 = MIDI 48 when baseOctave=3
  const lower: KeyDef[] = LOWER_KEYS.map((key, i) => ({
    key,
    note: `${NOTE_NAMES[i]}${baseOctave}`,
    midi: baseMidi + i,
    isBlack: IS_BLACK[i],
  }));
  const upper: KeyDef[] = UPPER_KEYS.map((key, i) => ({
    key,
    note: `${NOTE_NAMES[i]}${baseOctave + 1}`,
    midi: baseMidi + 12 + i,
    isBlack: IS_BLACK[i],
  }));
  return { lower, upper, all: [...lower, ...upper] };
}

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
  const [octave, setOctave] = useState(3); // base octave (C3–B4 default)
  const remoteActiveKeys = useCollabStore((s) => s.activeKeys);
  const onNoteOnRef = useRef(onNoteOn);
  const onNoteOffRef = useRef(onNoteOff);
  // onNoteOnRef.current = onNoteOn;
  // onNoteOffRef.current = onNoteOff;

  const { lower, upper, all } = buildKeys(octave);
  const keyMap = new Map<string, KeyDef>(all.map((k) => [k.key, k]));
  const keyMapRef = useRef(keyMap);
  keyMapRef.current = keyMap;
  const allKeysRef = useRef(all);
  allKeysRef.current = all;

  // Track which MIDI notes are held via mouse (for global mouseUp cleanup)
  const mousePressedRef = useRef<Set<number>>(new Set());

  // ── Keyboard handlers ───────────────────────────────────────────────────

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.repeat) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;

    const key = e.key.toLowerCase();
    const def = keyMapRef.current.get(key);
    if (!def) return;

    e.preventDefault();
    setActiveKeys((prev) => new Set(prev).add(key));
    onNoteOnRef.current(makeNoteEvent(def));
  }, []);

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    const def = keyMapRef.current.get(key);
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
        const def = allKeysRef.current.find((k) => k.midi === midi);
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
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOctave((o) => Math.max(0, o - 1))}
            disabled={octave <= 0}
            className="rounded bg-gray-700 px-1.5 py-0.5 text-[10px] font-mono text-gray-300
                       hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            −Oct
          </button>
          <span className="text-[10px] tabular-nums text-gray-400">
            C{octave}–B{octave + 1}
          </span>
          <button
            type="button"
            onClick={() => setOctave((o) => Math.min(7, o + 1))}
            disabled={octave >= 7}
            className="rounded bg-gray-700 px-1.5 py-0.5 text-[10px] font-mono text-gray-300
                       hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            +Oct
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <OctaveRow
          keys={upper}
          activeKeys={activeKeys}
          remoteActiveKeys={remoteActiveKeys}
          onMouseDown={handleMouseDown}
          onMouseUpOrLeave={handleMouseUpOrLeave}
          label={`C${octave + 1}–B${octave + 1}`}
        />
        <OctaveRow
          keys={lower}
          activeKeys={activeKeys}
          remoteActiveKeys={remoteActiveKeys}
          onMouseDown={handleMouseDown}
          onMouseUpOrLeave={handleMouseUpOrLeave}
          label={`C${octave}–B${octave}`}
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
  remoteActiveKeys,
  onMouseDown,
  onMouseUpOrLeave,
  label,
}: {
  keys: KeyDef[];
  activeKeys: Set<string>;
  remoteActiveKeys: Record<number, { username: string; color: string }[]>;
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
        const remoteUsers = remoteActiveKeys[def.midi];
        const remoteColor = remoteUsers?.[0]?.color;

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
              relative flex flex-col items-center justify-end rounded-b pb-0.5 text-center
              transition-colors duration-75 select-none
              ${isBlack
                ? `h-8 w-6 ${isActive ? "bg-indigo-500" : "bg-gray-950 hover:bg-gray-800"} text-gray-400`
                : `h-10 w-8 ${isActive ? "bg-indigo-400 text-gray-900" : "bg-gray-200 hover:bg-gray-300 text-gray-700"}`
              }
            `}
            style={
              remoteColor && !isActive
                ? { backgroundColor: remoteColor, opacity: 0.85 }
                : undefined
            }
          >
            <span className="text-[8px] leading-none font-mono">
              {def.key.toUpperCase()}
            </span>
            <span className="text-[7px] leading-none opacity-60">
              {def.note}
            </span>
            {remoteUsers && remoteUsers.length > 0 && (
              <span
                className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: remoteUsers[0].color }}
                title={remoteUsers.map((u) => u.username).join(", ")}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

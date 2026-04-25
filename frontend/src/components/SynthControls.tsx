/**
 * SynthControls — Synthesizer parameter panel with server-side DSP rendering.
 *
 * All audio processing happens on the backend (Rust DSP via Elixir NIF).
 * The "Render Sound" button triggers a single-voice preview render.
 * Keyboard note events are forwarded to the parent for recording workflows.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAudioWorklet } from "../hooks/useAudioWorklet";
import { useSocketStore } from "../store/useSocketStore";
import {
  DEFAULT_SYNTH_PARAMS,
  type DistortionType,
  type FilterTypeVariant,
  type LfoShape,
  type LfoTarget,
  type OscShape,
  type SynthParams,
} from "../types/daw";
import { Keyboard, type NoteEvent } from "./Keyboard";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SynthControlsProps {
  projectId: number;
  /** Called on keyboard note-on (for recording workflow). */
  onNoteOn?: (event: NoteEvent) => void;
  /** Called on keyboard note-off (for recording workflow). */
  onNoteOff?: (event: NoteEvent) => void;
}

export function SynthControls({ projectId: _projectId, onNoteOn, onNoteOff }: SynthControlsProps) {
  const [params, setParams] = useState<SynthParams>(DEFAULT_SYNTH_PARAMS);
  const channel = useSocketStore((s) => s.channel);
  const { init: initWorklet, feedPcm, getContext, destroy: destroyWorklet } = useAudioWorklet();

  // ── Real-time refs ────────────────────────────────────────────────────────
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Active note preview sources: midi → { source, gain }
  // Used to stop individual notes on key release.
  const activeNotesRef = useRef<Map<number, { source: AudioBufferSourceNode; gain: GainNode }>>(
    new Map(),
  );

  const paramsRef = useRef(params);
  paramsRef.current = params;

  // ── AudioWorklet lifecycle ────────────────────────────────────────────────
  useEffect(() => {
    initWorklet();
    return () => destroyWorklet();
  }, [initWorklet, destroyWorklet]);

  // ── Canvas draw loop removed — visualization now handled by AudioVisualization ──

  // ── WebSocket binary handler (server-rendered audio) ──────────────────────
  useEffect(() => {
    if (!channel) return;
    const ref = channel.on("audio_buffer", (payload: unknown) => {
      if (!(payload instanceof ArrayBuffer)) return;
      const pcm = new Float32Array(payload, 516);
      feedPcm(pcm);
    });
    return () => channel.off("audio_buffer", ref);
  }, [channel, feedPcm]);

  // ── Note preview handler (polyphonic keyboard preview via AudioBufferSourceNode) ──
  useEffect(() => {
    if (!channel) return;
    const ref = channel.on("note_audio", (payload: unknown) => {
      if (!(payload instanceof ArrayBuffer)) return;
      const ctx = getContext();
      if (!ctx) return;

      // Extract MIDI number from byte 1 (embedded by the server).
      const header = new Uint8Array(payload, 0, 4);
      const midi = header[1];

      // Extract PCM from the wire frame.
      const pcm = new Float32Array(payload, 516);

      // Stop any existing source for this MIDI note (re-trigger).
      const existing = activeNotesRef.current.get(midi);
      if (existing) {
        try { existing.source.stop(); } catch { /* already stopped */ }
        activeNotesRef.current.delete(midi);
      }

      // Create an AudioBuffer from the PCM data.
      const audioBuffer = ctx.createBuffer(1, pcm.length, 44100);
      audioBuffer.getChannelData(0).set(pcm);

      // Create source + gain for individual note control.
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      const gain = ctx.createGain();
      gain.gain.value = 1.0;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start();

      // Clean up when the source finishes naturally.
      source.onended = () => {
        activeNotesRef.current.delete(midi);
      };

      activeNotesRef.current.set(midi, { source, gain });
    });
    return () => channel.off("note_audio", ref);
  }, [channel, getContext]);

  // ── Debounced server render ───────────────────────────────────────────────
  const sendPatchUpdate = useCallback(
    (nextParams: SynthParams) => {
      if (!channel) return;
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        channel.push("patch_update", nextParams as unknown as Record<string, unknown>);
        debounceTimerRef.current = null;
      }, DEBOUNCE_MS);
    },
    [channel],
  );

  /** Send immediately (no debounce) — used for keyboard note triggers. */
  const sendNotePreview = useCallback(
    (frequency: number, midi: number) => {
      if (!channel) return;
      channel.push("note_preview", { frequency, midi });
    },
    [channel],
  );

  // ── Parameter change handler ──────────────────────────────────────────────
  const handleChange = useCallback(
    <K extends keyof SynthParams>(key: K, value: SynthParams[K]) => {
      setParams((prev) => {
        const next = { ...prev, [key]: value };
        sendPatchUpdate(next);
        return next;
      });
    },
    [sendPatchUpdate],
  );

  // ── Keyboard note-on / note-off ───────────────────────────────────────────
  const handleNoteOn = useCallback(
    (event: NoteEvent) => {
      // Server-side polyphonic preview: render a short note at this frequency.
      // Each note_preview spawns a concurrent Task on the server.
      // The response comes back via the `note_audio` event and plays as an
      // AudioBufferSourceNode until the key is released (handleNoteOff).
      sendNotePreview(event.frequency, event.midi);
      // Forward to parent (recording workflow)
      onNoteOn?.(event);
    },
    [sendNotePreview, onNoteOn],
  );

  const handleNoteOff = useCallback(
    (event: NoteEvent) => {
      // Stop the preview audio for this note with a short fade-out to avoid clicks.
      const active = activeNotesRef.current.get(event.midi);
      if (active) {
        const ctx = getContext();
        const now = ctx?.currentTime ?? 0;
        active.gain.gain.setTargetAtTime(0, now, 0.015); // ~45ms fade
        setTimeout(() => {
          try { active.source.stop(); } catch { /* already stopped */ }
          activeNotesRef.current.delete(event.midi);
        }, 80);
      }
      onNoteOff?.(event);
    },
    [onNoteOff, getContext],
  );

  return (
    <div className="flex flex-col gap-5 rounded-xl bg-gray-900 p-5 text-gray-100">
      <h2 className="text-lg font-semibold tracking-wide text-indigo-400">
        Synthesizer
      </h2>

      {/* ── Oscillator + Unison ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4">
        <SectionCard title="Oscillator">
          <SelectControl
            label="Shape"
            value={params.osc_shape}
            options={[
              { value: "saw", label: "Sawtooth" },
              { value: "sine", label: "Sine" },
              { value: "square", label: "Square" },
              { value: "triangle", label: "Triangle" },
            ]}
            onChange={(v) => handleChange("osc_shape", v as OscShape)}
          />
          <SliderControl
            label="Frequency" unit="Hz"
            value={params.frequency} min={20} max={2000} step={1}
            onChange={(v) => handleChange("frequency", v)}
          />
        </SectionCard>

        <SectionCard title="Unison">
          <SliderControl
            label="Voices" unit=""
            value={params.unison_voices} min={1} max={7} step={1}
            onChange={(v) => handleChange("unison_voices", Math.round(v))}
          />
          <SliderControl
            label="Detune" unit="ct"
            value={params.unison_detune} min={0} max={50} step={1}
            onChange={(v) => handleChange("unison_detune", v)}
          />
          <SliderControl
            label="Spread" unit=""
            value={params.unison_spread} min={0} max={1} step={0.01}
            onChange={(v) => handleChange("unison_spread", v)}
          />
        </SectionCard>
      </div>

      {/* ── Filter + LFO ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4">
        <SectionCard title="Filter">
          <SelectControl
            label="Type"
            value={params.filter_type}
            options={[
              { value: "svf", label: "SVF (clean)" },
              { value: "moog", label: "Moog (warm)" },
            ]}
            onChange={(v) => handleChange("filter_type", v as FilterTypeVariant)}
          />
          <SliderControl
            label="Cutoff" unit="Hz"
            value={params.cutoff} min={20} max={18000} step={10}
            onChange={(v) => handleChange("cutoff", v)}
          />
          <SliderControl
            label="Resonance" unit=""
            value={params.resonance} min={0} max={1} step={0.01}
            onChange={(v) => handleChange("resonance", v)}
          />
        </SectionCard>

        <SectionCard title="LFO">
          <SelectControl
            label="Shape"
            value={params.lfo_shape}
            options={[
              { value: "sine", label: "Sine" },
              { value: "triangle", label: "Triangle" },
              { value: "square", label: "Square" },
              { value: "saw", label: "Saw" },
            ]}
            onChange={(v) => handleChange("lfo_shape", v as LfoShape)}
          />
          <SelectControl
            label="Target"
            value={params.lfo_target}
            options={[
              { value: "cutoff", label: "Cutoff" },
              { value: "pitch", label: "Pitch" },
              { value: "volume", label: "Volume" },
            ]}
            onChange={(v) => handleChange("lfo_target", v as LfoTarget)}
          />
          <SliderControl
            label="Rate" unit="Hz"
            value={params.lfo_rate} min={0.1} max={20} step={0.1}
            onChange={(v) => handleChange("lfo_rate", v)}
          />
          <SliderControl
            label="Depth" unit=""
            value={params.lfo_depth} min={0} max={1} step={0.01}
            onChange={(v) => handleChange("lfo_depth", v)}
          />
        </SectionCard>
      </div>

      {/* ── Drive/Distortion + Effects ───────────────────────────────── */}
      <div className="grid grid-cols-3 gap-4">
        <SectionCard title="Drive / Distortion">
          <SliderControl
            label="Drive" unit="×"
            value={params.drive} min={1} max={10} step={0.1}
            onChange={(v) => handleChange("drive", v)}
          />
          <SelectControl
            label="Type"
            value={params.distortion_type}
            options={[
              { value: "off", label: "Off" },
              { value: "soft_clip", label: "Soft Clip" },
              { value: "hard_clip", label: "Hard Clip" },
              { value: "atan", label: "Arctan" },
            ]}
            onChange={(v) => handleChange("distortion_type", v as DistortionType)}
          />
          <SliderControl
            label="Amount" unit=""
            value={params.distortion_amount} min={0} max={1} step={0.01}
            onChange={(v) => handleChange("distortion_amount", v)}
          />
        </SectionCard>

        <SectionCard title="Chorus">
          <SliderControl
            label="Rate" unit="Hz"
            value={params.chorus_rate} min={0.1} max={5} step={0.1}
            onChange={(v) => handleChange("chorus_rate", v)}
          />
          <SliderControl
            label="Depth" unit=""
            value={params.chorus_depth} min={0} max={1} step={0.01}
            onChange={(v) => handleChange("chorus_depth", v)}
          />
          <SliderControl
            label="Mix" unit=""
            value={params.chorus_mix} min={0} max={1} step={0.01}
            onChange={(v) => handleChange("chorus_mix", v)}
          />
        </SectionCard>

        <SectionCard title="Reverb">
          <SliderControl
            label="Decay" unit=""
            value={params.reverb_decay} min={0} max={0.95} step={0.01}
            onChange={(v) => handleChange("reverb_decay", v)}
          />
          <SliderControl
            label="Mix" unit=""
            value={params.reverb_mix} min={0} max={1} step={0.01}
            onChange={(v) => handleChange("reverb_mix", v)}
          />
        </SectionCard>
      </div>

      {/* ── Volume + Render ──────────────────────────────────────────── */}
      <div className="flex items-end gap-4">
        <div className="flex-1">
          <SliderControl
            label="Volume" unit=""
            value={params.volume} min={0} max={1} step={0.01}
            onChange={(v) => handleChange("volume", v)}
          />
        </div>
        <button
          type="button"
          onClick={() => sendPatchUpdate(params)}
          disabled={!channel}
          className="shrink-0 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium
                     hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {channel ? "Render Sound" : "Connecting…"}
        </button>
      </div>

      {/* ── Keyboard ─────────────────────────────────────────────────── */}
      <Keyboard onNoteOn={handleNoteOn} onNoteOff={handleNoteOff} />

      {!channel && (
        <p className="text-center text-xs text-gray-500">
          Join a project session to enable the synthesizer.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SectionCard — styled container for parameter groups
// ---------------------------------------------------------------------------

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg bg-gray-800/50 p-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-gray-500">
        {title}
      </h3>
      <div className="flex flex-col gap-2">
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// SliderControl
// ---------------------------------------------------------------------------

interface SliderControlProps {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}

function SliderControl({ label, unit, value, min, max, step, onChange }: SliderControlProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between text-[11px]">
        <span className="text-gray-400">{label}</span>
        <span className="tabular-nums text-gray-300">
          {value.toFixed(step < 1 ? 2 : 0)}
          {unit && <span className="ml-0.5 text-gray-500">{unit}</span>}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-gray-700
                   accent-indigo-500"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SelectControl
// ---------------------------------------------------------------------------

interface SelectControlProps {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

function SelectControl({ label, value, options, onChange }: SelectControlProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="text-[11px] text-gray-400">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-100"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

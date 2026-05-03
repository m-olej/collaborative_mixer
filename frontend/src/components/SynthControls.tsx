/**
 * SynthControls — Synthesizer parameter panel with server-side DSP rendering.
 *
 * All audio processing happens on the backend (Rust DSP via Elixir NIF).
 * The "Render Sound" button triggers a single-voice preview render.
 * Keyboard note events are forwarded to the parent for recording workflows.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAudioWorklet } from "../hooks/useAudioWorklet";
import { useDesignViewStore } from "../store/useDesignViewStore";
import { useSocketStore } from "../store/useSocketStore";
import {
  type DistortionType,
  type FilterTypeVariant,
  type LfoShape,
  type LfoTarget,
  type OscShape,
  type SynthParams,
} from "../types/daw";
import { AdsrEnvelope, type AdsrParams } from "./AdsrEnvelope";
import { Keyboard, type NoteEvent } from "./Keyboard";
import { SYNTH_PRESETS, getPresetsByCategory } from "../presets/synthPresets";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SynthControlsProps {
  projectId: number;
  /** Design view id (e.g. "design:alice"). */
  viewId: string;
  /** Called on keyboard note-on (for recording workflow). */
  onNoteOn?: (event: NoteEvent) => void;
  /** Called on keyboard note-off (for recording workflow). */
  onNoteOff?: (event: NoteEvent) => void;
}

export function SynthControls({ projectId: _projectId, viewId, onNoteOn, onNoteOff }: SynthControlsProps) {
  const params = useDesignViewStore((s) => s.designViews[viewId]?.synth_params ?? s.getActiveParams());
  const patchView = useDesignViewStore((s) => s.patchView);
  const channel = useSocketStore((s) => s.channel);
  const { init: initWorklet, feedPcm, mixPcm, destroy: destroyWorklet } = useAudioWorklet();
  const [envTab, setEnvTab] = useState<"amp" | "filter">("amp");
  const [currentPreset, setCurrentPreset] = useState("");

  // ── Real-time refs ────────────────────────────────────────────────────────
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // ── Streaming voice audio handler (polyphonic keyboard preview via AudioWorklet) ──
  useEffect(() => {
    if (!channel) return;
    const ref = channel.on("voice_audio", (payload: unknown) => {
      if (!(payload instanceof ArrayBuffer)) return;
      // Ensure worklet is initialized (resumes AudioContext on first interaction).
      initWorklet();
      // Extract PCM from the wire frame (skip 516-byte header+FFT).
      const pcm = new Float32Array(payload, 516);
      // Mix additively into ring buffer for polyphonic playback.
      mixPcm(pcm);
    });
    return () => channel.off("voice_audio", ref);
  }, [channel, mixPcm, initWorklet]);

  // ── Debounced server param sync (no audio render) ──────────────────────────
  const sendParamSync = useCallback(
    (nextParams: SynthParams) => {
      if (!channel) return;
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        channel.push("sync_params", { ...nextParams, view_id: viewId } as unknown as Record<string, unknown>);
        debounceTimerRef.current = null;
      }, DEBOUNCE_MS);
    },
    [channel, viewId],
  );

  /** Render Sound — sends patch_update which triggers server render + audio response. */
  const sendRenderSound = useCallback(
    (nextParams: SynthParams) => {
      if (!channel) return;
      channel.push("patch_update", { ...nextParams, view_id: viewId } as unknown as Record<string, unknown>);
    },
    [channel, viewId],
  );

  /** Send immediately (no debounce) — used for keyboard note triggers. */
  const sendNotePreview = useCallback(
    (frequency: number, midi: number) => {
      if (!channel) return;
      channel.push("note_preview", { frequency, midi, view_id: viewId });
    },
    [channel, viewId],
  );

  // ── Parameter change handler ──────────────────────────────────────────────
  const handleChange = useCallback(
    <K extends keyof SynthParams>(key: K, value: SynthParams[K]) => {
      const next = { ...params, [key]: value };
      patchView(viewId, { [key]: value });
      sendParamSync(next);
      setCurrentPreset("");
    },
    [params, patchView, viewId, sendParamSync],
  );

  // ── Preset loader ──────────────────────────────────────────────────────────
  const handlePresetSelect = useCallback(
    (presetName: string) => {
      const preset = SYNTH_PRESETS.find((p) => p.name === presetName);
      if (!preset) return;
      patchView(viewId, preset.params);
      sendParamSync(preset.params);
      setCurrentPreset(presetName);
    },
    [patchView, viewId, sendParamSync],
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
      // Notify server to trigger ADSR release on the voice.
      // The server continues streaming the release tail + effects decay
      // until the voice is culled (voice_done event).
      channel?.push("key_up", { midi: event.midi });
      onNoteOff?.(event);
    },
    [channel, onNoteOff],
  );

  return (
    <div className="flex flex-col gap-5 rounded-xl bg-gray-900 p-5 text-gray-100">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-wide text-indigo-400">
          Synthesizer
        </h2>
        <PresetSelector value={currentPreset} onSelect={handlePresetSelect} />
      </div>

      {/* ── Oscillator + Unison ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4">
        <SectionCard title="Oscillator">
          <SelectControl
            label="Shape"
            value={params.osc_shape}
            options={[
              { value: "saw", label: "Sawtooth" },
              { value: "square", label: "Square" },
              { value: "triangle", label: "Triangle" },
              { value: "sine", label: "Sine" },
              { value: "noise", label: "White Noise" },
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
              { value: "svf", label: "Lowpass (SVF)" },
              { value: "moog", label: "Lowpass (Moog)" },
              { value: "highpass", label: "Highpass" },
              { value: "bandpass", label: "Bandpass" },
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
              { value: "soft_clip", label: "Soft Clip (tanh)" },
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

      {/* ── Envelopes (ADSR) ─────────────────────────────────────────── */}
      <SectionCard title="Envelopes">
        <div className="flex gap-2 border-b border-gray-700 pb-1">
          <button
            type="button"
            onClick={() => setEnvTab("amp")}
            className={`px-3 py-0.5 text-[11px] font-semibold rounded-t ${
              envTab === "amp"
                ? "bg-indigo-600/30 text-indigo-300"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            AMP
          </button>
          <button
            type="button"
            onClick={() => setEnvTab("filter")}
            className={`px-3 py-0.5 text-[11px] font-semibold rounded-t ${
              envTab === "filter"
                ? "bg-yellow-600/30 text-yellow-300"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            FILTER
          </button>
        </div>
        {envTab === "amp" ? (
          <AdsrEnvelope
            label="AMP"
            params={{
              attack_ms: params.amp_attack_ms,
              decay_ms: params.amp_decay_ms,
              sustain: params.amp_sustain,
              release_ms: params.amp_release_ms,
            }}
            onChange={(key, value) => {
              const paramKey = `amp_${key}` as keyof SynthParams;
              handleChange(paramKey, value as never);
            }}
          />
        ) : (
          <AdsrEnvelope
            label="FILTER"
            params={{
              attack_ms: params.filter_attack_ms,
              decay_ms: params.filter_decay_ms,
              sustain: params.filter_sustain,
              release_ms: params.filter_release_ms,
            }}
            onChange={(key, value) => {
              const paramKey = `filter_${key}` as keyof SynthParams;
              handleChange(paramKey, value as never);
            }}
            envDepth={params.filter_env_depth}
            onEnvDepthChange={(v) => handleChange("filter_env_depth", v)}
          />
        )}
      </SectionCard>

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
          onClick={() => sendRenderSound(params)}
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

// ---------------------------------------------------------------------------
// PresetSelector
// ---------------------------------------------------------------------------

function PresetSelector({ value, onSelect }: { value: string; onSelect: (name: string) => void }) {
  const categories = getPresetsByCategory();

  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value) onSelect(e.target.value);
      }}
      className="rounded bg-gray-800 px-2 py-1 text-xs text-gray-300 border border-gray-700"
    >
      <option value="">Presets…</option>
      {Array.from(categories.entries()).map(([category, presets]) => (
        <optgroup key={category} label={category}>
          {presets.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

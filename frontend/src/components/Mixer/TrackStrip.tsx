import { useCallback, useRef, useState } from "react";
import type { Channel } from "phoenix";
import type { EqSettings, TrackMixerState } from "../../types/daw";

/** Debounce delay for continuous controls (volume, EQ). */
const DEBOUNCE_MS = 150;

interface TrackStripProps {
  /** String key used as track identifier in the server mixer state. */
  trackId: string;
  /** Initial state snapshot received from the server on channel join. */
  initial: TrackMixerState;
  /** Phoenix Channel for sending slider_update events. */
  channel: Channel | null;
}

/**
 * A vertical mixer channel strip.
 *
 * Manages its own local UI state (volume, muted, eq) initialised from the
 * server snapshot.  Continuous controls (volume, EQ) are debounced before
 * being pushed to the channel; discrete controls (mute) are sent immediately.
 *
 * Per AGENTS.md §3: only slow UI state is held in useState.  There is no
 * high-frequency data in a mixer strip, so useState throughout is correct.
 */
export function TrackStrip({ trackId, initial, channel }: TrackStripProps) {
  const [volume, setVolume] = useState(initial.volume);
  const [muted, setMuted] = useState(initial.muted);
  const [eq, setEq] = useState<EqSettings>(initial.eq);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Push a slider_update payload merged with the track_id.
  const sendSlider = useCallback(
    (payload: Record<string, unknown>) => {
      channel?.push("slider_update", { track_id: trackId, ...payload });
    },
    [channel, trackId],
  );

  const handleVolume = useCallback(
    (v: number) => {
      setVolume(v);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        sendSlider({ volume: v });
        debounceRef.current = null;
      }, DEBOUNCE_MS);
    },
    [sendSlider],
  );

  const handleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    sendSlider({ muted: next });
  }, [muted, sendSlider]);

  const handleEq = useCallback(
    (band: keyof EqSettings, v: number) => {
      setEq((prev) => ({ ...prev, [band]: v }));
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        sendSlider({ eq_band: band, eq_value: v });
        debounceRef.current = null;
      }, DEBOUNCE_MS);
    },
    [sendSlider],
  );

  return (
    <div
      className={`flex w-32 shrink-0 flex-col gap-3 rounded-lg border bg-gray-900 px-3 py-4
        ${muted ? "border-yellow-700 opacity-60" : "border-gray-700"}`}
    >
      {/* Track label */}
      <p className="truncate text-center text-xs font-semibold text-gray-300">
        Track {trackId}
      </p>

      {/* Volume fader — rotated to appear vertical */}
      <div className="flex flex-col items-center gap-1">
        <span className="text-[10px] uppercase text-gray-500">Vol</span>
        <div className="flex h-24 items-center justify-center">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => handleVolume(parseFloat(e.target.value))}
            style={{ width: "80px", transform: "rotate(-90deg)" }}
            className="cursor-pointer appearance-none rounded accent-indigo-500"
          />
        </div>
        <span className="text-[10px] tabular-nums text-gray-400">
          {Math.round(volume * 100)}%
        </span>
      </div>

      {/* Mute toggle */}
      <button
        type="button"
        onClick={handleMute}
        className={`rounded py-1 text-xs font-bold transition-colors ${
          muted
            ? "bg-yellow-600 text-white"
            : "bg-gray-700 text-gray-300 hover:bg-gray-600"
        }`}
      >
        {muted ? "MUTED" : "LIVE"}
      </button>

      {/* 3-band EQ */}
      <div className="flex flex-col gap-2">
        <span className="text-[10px] uppercase text-gray-500">EQ (dB)</span>
        {(["high", "mid", "low"] as const).map((band) => (
          <EqBand
            key={band}
            label={band[0].toUpperCase()}
            value={eq[band]}
            onChange={(v) => handleEq(band, v)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EqBand — compact single-band EQ control
// ---------------------------------------------------------------------------

interface EqBandProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
}

function EqBand({ label, value, onChange }: EqBandProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between text-[10px]">
        <span className="text-gray-500">{label}</span>
        <span className="tabular-nums text-gray-400">
          {value >= 0 ? "+" : ""}
          {value.toFixed(1)}
        </span>
      </div>
      <input
        type="range"
        min={-12}
        max={12}
        step={0.5}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-gray-700 accent-indigo-500"
      />
    </div>
  );
}

import { useCallback, useRef, useState } from "react";
import type { Channel } from "phoenix";

const DEBOUNCE_MS = 150;

interface MasterBusProps {
  /** Initial master volume from the server state (0.0–1.0). */
  masterVolume: number;
  /** Initial transport playing state. */
  playing: boolean;
  /** Project BPM for display. */
  bpm: number;
  /** Phoenix channel for pushing slider_update events. */
  channel: Channel | null;
}

/**
 * Master bus strip.
 * Displays the master volume fader, transport (play/stop), and BPM.
 * Sends `slider_update: { master_volume }` and `slider_update: { playing }`.
 */
export function MasterBus({ masterVolume, playing, bpm, channel }: MasterBusProps) {
  const [volume, setVolume] = useState(masterVolume);
  const [isPlaying, setIsPlaying] = useState(playing);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleVolume = useCallback(
    (v: number) => {
      setVolume(v);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        channel?.push("slider_update", { master_volume: v });
        debounceRef.current = null;
      }, DEBOUNCE_MS);
    },
    [channel],
  );

  const handlePlayPause = useCallback(() => {
    const next = !isPlaying;
    setIsPlaying(next);
    channel?.push("slider_update", { playing: next });
  }, [isPlaying, channel]);

  return (
    <div className="flex w-32 shrink-0 flex-col gap-3 rounded-lg border border-indigo-800 bg-gray-900 px-3 py-4">
      <p className="text-center text-xs font-bold uppercase tracking-widest text-indigo-400">
        Master
      </p>

      {/* Master volume fader */}
      <div className="flex flex-col items-center gap-1">
        <span className="text-[10px] uppercase text-gray-500">Level</span>
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

      {/* Transport */}
      <button
        type="button"
        onClick={handlePlayPause}
        disabled={!channel}
        className={`rounded py-1.5 text-xs font-bold transition-colors disabled:opacity-40 ${
          isPlaying
            ? "bg-red-600 text-white hover:bg-red-500"
            : "bg-green-700 text-white hover:bg-green-600"
        }`}
      >
        {isPlaying ? "■ STOP" : "▶ PLAY"}
      </button>

      {/* BPM display */}
      <div className="mt-auto text-center">
        <span className="text-[10px] text-gray-500">{bpm} BPM</span>
      </div>
    </div>
  );
}

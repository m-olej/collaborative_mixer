import type { Track, Sample } from "../../types/daw";
import { TimelineClip } from "./TimelineClip";

interface TimelineLaneProps {
  laneIndex: number;
  tracks: Track[];
  samples: Sample[];
  height: number;
  pxPerMs: number;
  msPerBeat: number;
  beatsPerBar: number;
  totalWidth: number;
  projectId: number;
  snapPositionMs: (rawMs: number) => number;
  onDrop: (e: React.DragEvent) => void;
}

/**
 * A single horizontal lane in the timeline.
 * Renders clips positioned by position_ms and acts as a drop target.
 * Also draws beat grid lines in the background.
 */
export function TimelineLane({
  laneIndex,
  tracks,
  samples,
  height,
  pxPerMs,
  msPerBeat,
  beatsPerBar,
  totalWidth,
  projectId,
  snapPositionMs,
  onDrop,
}: TimelineLaneProps) {
  // Generate beat grid lines
  const barMs = msPerBeat * beatsPerBar;
  const totalMs = totalWidth / pxPerMs;
  const lines: { x: number; isBar: boolean }[] = [];

  for (let ms = 0; ms < totalMs; ms += msPerBeat) {
    const isBar = Math.abs(ms % barMs) < 0.1;
    lines.push({ x: ms * pxPerMs, isBar });
  }

  return (
    <div
      data-lane={laneIndex}
      className="relative border-b border-gray-800"
      style={{ height, width: totalWidth }}
      onDrop={onDrop}
      onDragOver={(e) => {
        e.preventDefault();
        // Set correct dropEffect based on drag source
        if (e.dataTransfer.types.includes("application/x-clip-move")) {
          e.dataTransfer.dropEffect = "move";
        } else {
          e.dataTransfer.dropEffect = "copy";
        }
      }}
    >
      {/* Beat grid lines */}
      {lines.map((line, i) => (
        <div
          key={i}
          className="absolute top-0 bottom-0"
          style={{
            left: line.x,
            width: 1,
            backgroundColor: line.isBar ? "rgba(99,102,241,0.3)" : "rgba(55,65,81,0.4)",
          }}
        />
      ))}

      {/* Clips */}
      {tracks.map((track) => {
        const sample = samples.find((s) => s.s3_key === track.s3_key);
        return (
          <TimelineClip
            key={track.id}
            track={track}
            sample={sample ?? null}
            pxPerMs={pxPerMs}
            height={height - 8}
            projectId={projectId}
            snapPositionMs={snapPositionMs}
          />
        );
      })}
    </div>
  );
}

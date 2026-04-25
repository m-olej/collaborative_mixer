import { useCallback, useEffect, useRef } from "react";
import type { Project, Track, Sample, SnapResolution } from "../../types/daw";
import { parseTimeSignature } from "../../types/daw";
import { useTimelineStore } from "../../store/useTimelineStore";
import { TimelineLane } from "./TimelineLane";

interface TimelineProps {
  project: Project;
  samples: Sample[];
}

const LANE_HEIGHT = 72;
const GUTTER_WIDTH = 120;
const RULER_HEIGHT = 28;

/**
 * Main timeline view. Renders a beat grid with lanes for placing sample clips.
 * Handles drag-and-drop from SampleBrowser and clip repositioning.
 */
export function Timeline({ project, samples }: TimelineProps) {
  const {
    tracks,
    zoom,
    snapEnabled,
    snapResolution,
    setZoom,
    setSnap,
    fetchTracks,
    placeTrack,
  } = useTimelineStore();

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchTracks(project.id);
  }, [project.id, fetchTracks]);

  const [beatsPerBar] = parseTimeSignature(project.time_signature);
  const msPerBeat = 60000 / project.bpm;
  const pxPerMs = zoom / msPerBeat;

  // Calculate total timeline width (at least 4 bars or enough to fit all clips)
  const maxPositionMs = tracks.reduce(
    (max, t) => {
      const smp = samples.find((s) => s.s3_key === t.s3_key);
      const end = t.position_ms + (smp?.duration_ms ?? 2000);
      return Math.max(max, end);
    },
    beatsPerBar * msPerBeat * 8,
  );
  const totalWidth = Math.ceil(maxPositionMs * pxPerMs) + 200;

  // Group tracks by lane_index
  const laneMap = new Map<number, Track[]>();
  for (const track of tracks) {
    const existing = laneMap.get(track.lane_index) ?? [];
    existing.push(track);
    laneMap.set(track.lane_index, existing);
  }
  const maxLane = Math.max(0, ...laneMap.keys());
  const laneIndices = Array.from({ length: maxLane + 2 }, (_, i) => i); // +1 empty lane

  // Snap helper
  const snapPositionMs = useCallback(
    (rawMs: number): number => {
      if (!snapEnabled || snapResolution === "free") return Math.max(0, rawMs);
      let gridMs: number;
      switch (snapResolution) {
        case "bar":
          gridMs = msPerBeat * beatsPerBar;
          break;
        case "beat":
          gridMs = msPerBeat;
          break;
        case "1/8":
          gridMs = msPerBeat / 2;
          break;
        case "1/16":
          gridMs = msPerBeat / 4;
          break;
        default:
          gridMs = msPerBeat;
      }
      return Math.max(0, Math.round(rawMs / gridMs) * gridMs);
    },
    [snapEnabled, snapResolution, msPerBeat, beatsPerBar],
  );

  // Handle drop on empty lane area (new track placement from sample browser)
  const handleDrop = useCallback(
    (e: React.DragEvent, laneIndex: number) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData("application/json");
      if (!raw) return;

      try {
        const sample = JSON.parse(raw) as Sample;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
        const dropX = e.clientX - rect.left + scrollLeft;
        const rawMs = dropX / pxPerMs;
        const positionMs = snapPositionMs(rawMs);

        placeTrack(project.id, {
          name: sample.name,
          sample_id: sample.id,
          lane_index: laneIndex,
          position_ms: Math.round(positionMs),
        });
      } catch { /* invalid data */ }
    },
    [pxPerMs, snapPositionMs, placeTrack, project.id],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  return (
    <div className="flex flex-col border-b border-gray-800">
      {/* ── Toolbar ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 border-b border-gray-800 px-4 py-2">
        <label className="flex items-center gap-2 text-xs text-gray-400">
          Zoom
          <input
            type="range"
            min={10}
            max={120}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-24 accent-indigo-500"
          />
          <span className="w-8 text-right tabular-nums text-gray-500">
            {zoom}
          </span>
        </label>

        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input
            type="checkbox"
            checked={snapEnabled}
            onChange={(e) => setSnap(e.target.checked)}
            className="accent-indigo-500"
          />
          Snap
        </label>

        {snapEnabled && (
          <select
            value={snapResolution}
            onChange={(e) => setSnap(true, e.target.value as SnapResolution)}
            className="rounded bg-gray-800 px-2 py-1 text-xs text-gray-300"
          >
            <option value="bar">Bar</option>
            <option value="beat">Beat</option>
            <option value="1/8">1/8</option>
            <option value="1/16">1/16</option>
            <option value="free">Free</option>
          </select>
        )}
      </div>

      {/* ── Timeline body ──────────────────────────────────────── */}
      <div className="flex overflow-hidden" style={{ maxHeight: LANE_HEIGHT * 6 + RULER_HEIGHT }}>
        {/* Lane labels gutter */}
        <div className="shrink-0" style={{ width: GUTTER_WIDTH }}>
          <div
            className="border-b border-r border-gray-800 bg-gray-900 text-[10px] text-gray-500 px-2"
            style={{ height: RULER_HEIGHT, lineHeight: `${RULER_HEIGHT}px` }}
          >
            Timeline
          </div>
          {laneIndices.map((i) => (
            <div
              key={i}
              className="flex items-center border-b border-r border-gray-800 bg-gray-900 px-2 text-xs text-gray-400"
              style={{ height: LANE_HEIGHT }}
            >
              Lane {i + 1}
            </div>
          ))}
        </div>

        {/* Scrollable grid + lanes */}
        <div ref={scrollRef} className="flex-1 overflow-auto">
          <div style={{ width: totalWidth, minWidth: "100%" }}>
            {/* Ruler */}
            <TimelineRuler
              totalWidth={totalWidth}
              msPerBeat={msPerBeat}
              beatsPerBar={beatsPerBar}
              pxPerMs={pxPerMs}
              height={RULER_HEIGHT}
            />

            {/* Lanes */}
            {laneIndices.map((i) => (
              <TimelineLane
                key={i}
                laneIndex={i}
                tracks={laneMap.get(i) ?? []}
                samples={samples}
                height={LANE_HEIGHT}
                pxPerMs={pxPerMs}
                msPerBeat={msPerBeat}
                beatsPerBar={beatsPerBar}
                totalWidth={totalWidth}
                projectId={project.id}
                snapPositionMs={snapPositionMs}
                onDrop={(e) => handleDrop(e, i)}
                onDragOver={handleDragOver}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ruler (beat/bar markers)
// ---------------------------------------------------------------------------

function TimelineRuler({
  totalWidth,
  msPerBeat,
  beatsPerBar,
  pxPerMs,
  height,
}: {
  totalWidth: number;
  msPerBeat: number;
  beatsPerBar: number;
  pxPerMs: number;
  height: number;
}) {
  const barMs = msPerBeat * beatsPerBar;
  const totalMs = totalWidth / pxPerMs;
  const bars = Math.ceil(totalMs / barMs);

  return (
    <div
      className="relative border-b border-gray-700 bg-gray-950"
      style={{ width: totalWidth, height }}
    >
      {Array.from({ length: bars }, (_, i) => {
        const x = i * barMs * pxPerMs;
        return (
          <span
            key={i}
            className="absolute top-0 text-[10px] text-gray-500 px-1"
            style={{ left: x, lineHeight: `${height}px` }}
          >
            {i + 1}
          </span>
        );
      })}
    </div>
  );
}

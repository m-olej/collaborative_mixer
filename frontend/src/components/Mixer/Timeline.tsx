import { useCallback, useEffect, useRef } from "react";
import type { Project, Track, Sample, SnapResolution } from "../../types/daw";
import { parseTimeSignature } from "../../types/daw";
import { useTimelineStore } from "../../store/useTimelineStore";
import { useSocketStore } from "../../store/useSocketStore";
import { useCollabStore } from "../../store/useCollabStore";
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
    playheadMs,
    playing,
    userCursors,
  } = useTimelineStore();

  const { pushStartPlayback, pushStopPlayback, pushSeek } = useSocketStore();
  const localColor = useCollabStore((s) => s.localUser.color);

  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);
  const playStartRef = useRef<{ wallMs: number; cursorMs: number }>({ wallMs: 0, cursorMs: 0 });

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

  // ── Playhead animation ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing) {
      cancelAnimationFrame(animFrameRef.current);
      // Update the playhead position one last time when stopped.
      if (playheadRef.current) {
        playheadRef.current.style.left = `${playheadMs * pxPerMs}px`;
      }
      return;
    }

    playStartRef.current = { wallMs: performance.now(), cursorMs: playheadMs };

    const tick = () => {
      const elapsed = performance.now() - playStartRef.current.wallMs;
      const currentMs = playStartRef.current.cursorMs + elapsed;
      if (playheadRef.current) {
        playheadRef.current.style.left = `${currentMs * pxPerMs}px`;
      }
      useTimelineStore.setState({ playheadMs: currentMs });
      animFrameRef.current = requestAnimationFrame(tick);
    };

    animFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [playing, pxPerMs]); // intentionally omit playheadMs to avoid restart loop

  // ── Ruler seek-on-click ───────────────────────────────────────────────────
  const handleRulerClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
      const clickX = e.clientX - rect.left + scrollLeft;
      const clickMs = Math.max(0, clickX / pxPerMs);

      if (playing) {
        // Seek while playing.
        pushSeek(clickMs);
        playStartRef.current = { wallMs: performance.now(), cursorMs: clickMs };
      } else {
        // Click to start playback from this position.
        pushStartPlayback(clickMs);
      }
    },
    [pxPerMs, playing, pushSeek, pushStartPlayback],
  );

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
          <div className="relative" style={{ width: totalWidth, minWidth: "100%" }}>
            {/* Ruler (click to seek/play) */}
            <TimelineRuler
              totalWidth={totalWidth}
              msPerBeat={msPerBeat}
              beatsPerBar={beatsPerBar}
              pxPerMs={pxPerMs}
              height={RULER_HEIGHT}
              onClick={handleRulerClick}
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

            {/* Playhead cursor (local) */}
            <div
              ref={playheadRef}
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-px"
              style={{
                left: `${playheadMs * pxPerMs}px`,
                backgroundColor: localColor,
              }}
            >
              <div
                className="absolute -top-0 -left-1 h-2.5 w-2.5"
                style={{
                  backgroundColor: localColor,
                  clipPath: "polygon(50% 100%, 0 0, 100% 0)",
                }}
              />
            </div>

            {/* Remote user cursors */}
            {Object.entries(userCursors).map(([username, { color, cursor_ms }]) => (
              <div
                key={username}
                className="pointer-events-none absolute top-0 bottom-0 z-10 w-px opacity-60"
                style={{
                  left: `${cursor_ms * pxPerMs}px`,
                  backgroundColor: color,
                }}
              >
                <span
                  className="absolute -top-3.5 left-1 whitespace-nowrap rounded px-1 py-0.5 text-[8px] text-white"
                  style={{ backgroundColor: color }}
                >
                  {username}
                </span>
              </div>
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
  onClick,
}: {
  totalWidth: number;
  msPerBeat: number;
  beatsPerBar: number;
  pxPerMs: number;
  height: number;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const barMs = msPerBeat * beatsPerBar;
  const totalMs = totalWidth / pxPerMs;
  const bars = Math.ceil(totalMs / barMs);

  return (
    <div
      className="relative cursor-pointer border-b border-gray-700 bg-gray-950"
      style={{ width: totalWidth, height }}
      onClick={onClick}
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

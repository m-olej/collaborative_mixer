import { useCallback, useEffect, useRef, useState } from "react";
import type { Project, Track, Sample, SnapResolution } from "../../types/daw";
import { parseTimeSignature } from "../../types/daw";
import { useTimelineStore } from "../../store/useTimelineStore";
import type { LaneConfig } from "../../store/useTimelineStore";
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
const DEFAULT_LANE_COLOR = "#374151";
const LANE_COLORS = [
  "#374151", "#991b1b", "#92400e", "#065f46", "#1e40af",
  "#5b21b6", "#9d174d", "#78350f", "#115e59", "#4338ca",
];

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
    moveTrack,
    batchMoveSelectedTracks,
    playheadMs,
    playing,
    userCursors,
    laneConfigs,
    laneOrder,
    addLane,
    removeLane,
    renameLane,
    setLaneColor,
    setLaneOrder,
    syncLanesFromTracks,
  } = useTimelineStore();

  const { pushStartPlayback, pushStopPlayback, pushSeek, pushLaneUpdate } = useSocketStore();
  const localColor = useCollabStore((s) => s.localUser.color);

  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);
  const playStartRef = useRef<{ wallMs: number; cursorMs: number }>({ wallMs: 0, cursorMs: 0 });
  const laneInitRef = useRef(false);

  useEffect(() => {
    fetchTracks(project.id).then(() => {
      syncLanesFromTracks();
      // Mark init done after first lane sync so we don't broadcast the initial state.
      laneInitRef.current = true;
    });
  }, [project.id, fetchTracks, syncLanesFromTracks]);

  // Broadcast lane changes to other users after local mutations.
  useEffect(() => {
    if (!laneInitRef.current) return;
    pushLaneUpdate(laneConfigs, laneOrder);
  }, [laneConfigs, laneOrder, pushLaneUpdate]);

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
        console.debug(`[Timeline:UI] ruler seek to ${clickMs.toFixed(1)}ms (playing)`);
        pushSeek(clickMs);
        playStartRef.current = { wallMs: performance.now(), cursorMs: clickMs };
      } else {
        // Click to start playback from this position.
        console.debug(`[Timeline:UI] ruler start playback at ${clickMs.toFixed(1)}ms`);
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

  // Lane drag-reorder state
  const [dragLaneFrom, setDragLaneFrom] = useState<number | null>(null);
  const [dragLaneOver, setDragLaneOver] = useState<number | null>(null);

  const handleLaneDragStart = useCallback((laneIndex: number) => {
    setDragLaneFrom(laneIndex);
  }, []);

  const handleLaneDragOver = useCallback((laneIndex: number) => {
    setDragLaneOver(laneIndex);
  }, []);

  const handleLaneDragEnd = useCallback(() => {
    if (dragLaneFrom !== null && dragLaneOver !== null && dragLaneFrom !== dragLaneOver) {
      const newOrder = [...laneOrder];
      const fromIdx = newOrder.indexOf(dragLaneFrom);
      const toIdx = newOrder.indexOf(dragLaneOver);
      if (fromIdx !== -1 && toIdx !== -1) {
        newOrder.splice(fromIdx, 1);
        newOrder.splice(toIdx, 0, dragLaneFrom);
        setLaneOrder(newOrder);
      }
    }
    setDragLaneFrom(null);
    setDragLaneOver(null);
  }, [dragLaneFrom, dragLaneOver, laneOrder, setLaneOrder]);

  // Delete lane handler
  const handleDeleteLane = useCallback(
    (laneIndex: number) => {
      const laneTracks = laneMap.get(laneIndex) ?? [];
      if (laneTracks.length > 0) {
        if (!confirm(`Lane "${laneConfigs[laneIndex]?.name ?? `Lane ${laneIndex + 1}`}" contains ${laneTracks.length} clip(s). Delete lane and all its clips?`)) {
          return;
        }
      }
      removeLane(laneIndex, project.id, true);
    },
    [laneMap, laneConfigs, removeLane, project.id],
  );

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

  // Handle drop on lane area (new track from sample browser OR clip move)
  const handleDrop = useCallback(
    (e: React.DragEvent, laneIndex: number) => {
      e.preventDefault();

      // ── Handle clip move ────────────────────────────────────────────────
      const clipData = e.dataTransfer.getData("application/x-clip-move");
      if (clipData) {
        try {
          const { trackId, laneIndex: origLane, selectedIds } = JSON.parse(clipData) as {
            trackId: number;
            laneIndex: number;
            selectedIds: number[];
          };
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
          const dropX = e.clientX - rect.left + scrollLeft;
          const rawMs = dropX / pxPerMs;
          const positionMs = snapPositionMs(rawMs);

          console.debug(`[Timeline:UI] clip drop track=${trackId} from lane=${origLane} to lane=${laneIndex} pos=${positionMs.toFixed(1)}ms selected=${selectedIds}`);

          if (selectedIds.length > 1) {
            const origTrack = tracks.find((t) => t.id === trackId);
            const deltaMs = positionMs - (origTrack?.position_ms ?? 0);
            const deltaLane = laneIndex - origLane;
            console.debug(`[Timeline:UI] batch move delta_ms=${deltaMs.toFixed(1)} delta_lane=${deltaLane} ids=${selectedIds}`);
            batchMoveSelectedTracks(project.id, deltaMs, deltaLane, selectedIds);
          } else {
            moveTrack(project.id, trackId, {
              position_ms: Math.round(positionMs),
              lane_index: laneIndex,
            });
          }
        } catch {
          /* invalid data */
        }
        return;
      }

      // ── Handle sample from browser ──────────────────────────────────────
      const raw = e.dataTransfer.getData("application/json");
      if (!raw) return;

      try {
        const sample = JSON.parse(raw) as Sample;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
        const dropX = e.clientX - rect.left + scrollLeft;
        const rawMs = dropX / pxPerMs;
        const positionMs = snapPositionMs(rawMs);

        console.debug(`[Timeline:UI] sample drop name=${sample.name} id=${sample.id} lane=${laneIndex} pos=${positionMs.toFixed(1)}ms duration=${sample.duration_ms}ms`);

        placeTrack(project.id, {
          name: sample.name,
          sample_id: sample.id,
          lane_index: laneIndex,
          position_ms: Math.round(positionMs),
        });
      } catch {
        /* invalid data */
      }
    },
    [pxPerMs, snapPositionMs, placeTrack, moveTrack, batchMoveSelectedTracks, project.id, tracks],
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
          {laneOrder.map((laneIdx) => (
            <LaneGutterItem
              key={laneIdx}
              laneIndex={laneIdx}
              config={laneConfigs[laneIdx] ?? { name: `Lane ${laneIdx + 1}`, color: DEFAULT_LANE_COLOR }}
              height={LANE_HEIGHT}
              onRename={(name) => renameLane(laneIdx, name)}
              onColorChange={(color) => setLaneColor(laneIdx, color)}
              onDelete={() => handleDeleteLane(laneIdx)}
              onDragStart={() => handleLaneDragStart(laneIdx)}
              onDragOver={() => handleLaneDragOver(laneIdx)}
              onDragEnd={handleLaneDragEnd}
              isDragOver={dragLaneOver === laneIdx && dragLaneFrom !== laneIdx}
            />
          ))}
          {/* Add lane button */}
          <div
            className="flex items-center justify-center border-b border-r border-gray-800 bg-gray-900 cursor-pointer hover:bg-gray-800 transition-colors"
            style={{ height: LANE_HEIGHT }}
            onClick={() => addLane()}
            title="Add lane"
          >
            <span className="text-lg text-gray-500 hover:text-indigo-400">+</span>
          </div>
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
            {laneOrder.map((laneIdx) => (
              <TimelineLane
                key={laneIdx}
                laneIndex={laneIdx}
                tracks={laneMap.get(laneIdx) ?? []}
                samples={samples}
                height={LANE_HEIGHT}
                pxPerMs={pxPerMs}
                msPerBeat={msPerBeat}
                beatsPerBar={beatsPerBar}
                totalWidth={totalWidth}
                projectId={project.id}
                snapPositionMs={snapPositionMs}
                onDrop={(e) => handleDrop(e, laneIdx)}
              />
            ))}
            {/* Empty add-lane drop zone */}
            <div
              className="border-b border-gray-800"
              style={{ height: LANE_HEIGHT, width: totalWidth }}
              onDrop={(e) => {
                const newIdx = addLane();
                handleDrop(e, newIdx);
              }}
              onDragOver={handleDragOver}
            />

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
// LaneGutterItem — editable lane label with color, rename, delete, drag
// ---------------------------------------------------------------------------

function LaneGutterItem({
  laneIndex,
  config,
  height,
  onRename,
  onColorChange,
  onDelete,
  onDragStart,
  onDragOver,
  onDragEnd,
  isDragOver,
}: {
  laneIndex: number;
  config: LaneConfig;
  height: number;
  onRename: (name: string) => void;
  onColorChange: (color: string) => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragEnd: () => void;
  isDragOver: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(config.name);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== config.name) {
      onRename(trimmed);
    } else {
      setEditValue(config.name);
    }
    setEditing(false);
  };

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-lane-reorder", String(laneIndex));
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDragEnd={onDragEnd}
      className={`group flex items-center gap-1 border-b border-r border-gray-800 bg-gray-900 px-1.5 text-xs text-gray-400 ${
        isDragOver ? "bg-indigo-900/30" : ""
      }`}
      style={{ height }}
    >
      {/* Drag handle */}
      <span className="cursor-grab text-[10px] text-gray-600 opacity-0 group-hover:opacity-100" title="Drag to reorder">
        ⠿
      </span>

      {/* Color indicator + picker */}
      <div className="relative">
        <button
          type="button"
          className="h-3 w-3 rounded-sm border border-gray-600 shrink-0"
          style={{ backgroundColor: config.color }}
          onClick={() => setShowColorPicker(!showColorPicker)}
          title="Lane color"
        />
        {showColorPicker && (
          <div className="absolute left-0 top-5 z-50 flex flex-wrap gap-1 rounded bg-gray-800 p-1.5 shadow-lg" style={{ width: 82 }}>
            {LANE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="h-4 w-4 rounded-sm border border-gray-600 hover:scale-110 transition-transform"
                style={{ backgroundColor: c }}
                onClick={() => {
                  onColorChange(c);
                  setShowColorPicker(false);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Editable name */}
      {editing ? (
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setEditValue(config.name);
              setEditing(false);
            }
          }}
          maxLength={30}
          className="min-w-0 flex-1 rounded bg-gray-800 px-1 py-0.5 text-xs text-white outline-none focus:ring-1 focus:ring-indigo-500"
        />
      ) : (
        <span
          className="min-w-0 flex-1 truncate cursor-text"
          onDoubleClick={() => {
            setEditValue(config.name);
            setEditing(true);
          }}
          title="Double-click to rename"
        >
          {config.name}
        </span>
      )}

      {/* Delete button */}
      <button
        type="button"
        onClick={onDelete}
        className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity text-xs shrink-0"
        title="Delete lane"
      >
        ✕
      </button>
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

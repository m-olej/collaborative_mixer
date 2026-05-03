import { useCallback, useEffect, useRef, useState } from "react";
import type { Track, Sample } from "../../types/daw";
import { useTimelineStore } from "../../store/useTimelineStore";
import { useSocketStore } from "../../store/useSocketStore";
import { useCollabStore } from "../../store/useCollabStore";

interface TimelineClipProps {
  track: Track;
  sample: Sample | null;
  pxPerMs: number;
  height: number;
  projectId: number;
  snapPositionMs: (rawMs: number) => number;
}

/**
 * A single clip on the timeline. Displays the sample name and a waveform
 * thumbnail. Draggable for repositioning, with right-click to delete.
 * Shows colored borders when selected by collaborators.
 */
export function TimelineClip({
  track,
  sample,
  pxPerMs,
  height,
  projectId,
  snapPositionMs,
}: TimelineClipProps) {
  const moveTrack = useTimelineStore((s) => s.moveTrack);
  const removeTrack = useTimelineStore((s) => s.removeTrack);
  const selectedTrackIds = useTimelineStore((s) => s.selectedTrackIds);
  const selectTrack = useTimelineStore((s) => s.selectTrack);
  const toggleTrackSelection = useTimelineStore((s) => s.toggleTrackSelection);
  const batchMoveSelectedTracks = useTimelineStore((s) => s.batchMoveSelectedTracks);
  const draggingByUser = useTimelineStore((s) => s.draggingByUser);
  const channel = useSocketStore((s) => s.channel);
  const pushSelectionUpdate = useSocketStore((s) => s.pushSelectionUpdate);
  const { localSelection, setLocalSelection, remoteUsers } = useCollabStore();
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const durationMs = sample?.duration_ms ?? 2000;
  const widthPx = durationMs * pxPerMs;
  const leftPx = track.position_ms * pxPerMs;

  // Draw waveform peaks
  useEffect(() => {
    const canvas = waveformRef.current;
    if (!canvas || !sample?.waveform_peaks?.length) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const peaks = sample.waveform_peaks;
    const W = canvas.width;
    const H = canvas.height;
    const midY = H / 2;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(99, 102, 241, 0.5)";

    const step = W / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const { min, max } = peaks[i];
      const top = midY - max * midY * 0.9;
      const bottom = midY - min * midY * 0.9;
      ctx.fillRect(i * step, top, Math.max(step - 0.5, 0.5), bottom - top);
    }
  }, [sample?.waveform_peaks]);

  const isMultiSelected = selectedTrackIds.has(track.id);

  // Drag start
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      setIsDragging(true);

      // If this track isn't in the multi-selection, select it alone.
      if (!selectedTrackIds.has(track.id)) {
        selectTrack(track.id);
      }

      const draggedIds = selectedTrackIds.has(track.id)
        ? Array.from(selectedTrackIds)
        : [track.id];

      e.dataTransfer.setData(
        "application/x-clip-move",
        JSON.stringify({ trackId: track.id, laneIndex: track.lane_index, selectedIds: draggedIds }),
      );
      e.dataTransfer.effectAllowed = "move";

      // Broadcast drag start to peers.
      channel?.push("tracks_dragging", { track_ids: draggedIds });
    },
    [track.id, track.lane_index, selectedTrackIds, selectTrack, channel],
  );

  // Drag end — clean up visual state, move is handled by Timeline.handleDrop
  const handleDragEnd = useCallback(
    () => {
      setIsDragging(false);
      channel?.push("tracks_drag_end", {});
    },
    [channel],
  );

  // Context menu: delete
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (confirm(`Delete "${track.name}" from timeline?`)) {
        removeTrack(projectId, track.id);
      }
    },
    [removeTrack, projectId, track.id, track.name],
  );

  // Selection (Ctrl+Click for multi, plain click for single)
  const isSelected = localSelection?.type === "timeline_clip" && localSelection.id === track.id;

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.ctrlKey || e.metaKey) {
        toggleTrackSelection(track.id);
      } else {
        selectTrack(track.id);
        const sel = isSelected ? null : { type: "timeline_clip" as const, id: track.id };
        setLocalSelection(sel);
        pushSelectionUpdate(sel);
      }
    },
    [isSelected, setLocalSelection, pushSelectionUpdate, selectTrack, toggleTrackSelection, track.id],
  );

  // Check if any remote user has this clip selected
  const remoteSelectors = Object.values(remoteUsers).filter(
    (u) => u.selection?.type === "timeline_clip" && u.selection.id === track.id,
  );

  // Check if any remote user is dragging this clip
  const remoteDragColor = Object.values(draggingByUser).find(
    (d) => d.track_ids.includes(track.id),
  )?.color;

  const borderColor = isMultiSelected || isSelected
    ? "#6366f1"
    : remoteDragColor
      ? remoteDragColor
      : remoteSelectors.length > 0
        ? remoteSelectors[0].color
        : "rgba(75,85,99,0.6)";

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onContextMenu={handleContextMenu}
      onClick={handleClick}
      className="absolute top-1 flex cursor-grab flex-col rounded"
      style={{
        left: leftPx,
        width: Math.max(widthPx, 20),
        height,
        backgroundColor: "rgba(30, 30, 46, 0.9)",
        border: `2px solid ${borderColor}`,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      {/* Sample name */}
      <div className="truncate px-1.5 pt-0.5 text-[10px] font-medium text-gray-300">
        {track.name}
      </div>

      {/* Waveform canvas */}
      <canvas
        ref={waveformRef}
        width={200}
        height={Math.max(height - 18, 10)}
        className="w-full flex-1 px-0.5"
      />
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { Track, Sample } from "../../types/daw";
import { useTimelineStore } from "../../store/useTimelineStore";
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

  // Drag start
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      setIsDragging(true);
      e.dataTransfer.setData(
        "application/x-clip-move",
        JSON.stringify({ trackId: track.id, laneIndex: track.lane_index }),
      );
      e.dataTransfer.effectAllowed = "move";
    },
    [track.id, track.lane_index],
  );

  // Drag end — calculate new position
  const handleDragEnd = useCallback(
    (e: React.DragEvent) => {
      setIsDragging(false);
      if (e.dataTransfer.dropEffect === "none") return;

      // The parent lane's drop handler will compute the new position
      // via the clip-move data transfer. We handle it here as well for
      // intra-lane repositioning.
      const parentRect = (e.currentTarget as HTMLElement)
        .closest("[data-lane]")
        ?.getBoundingClientRect();
      if (!parentRect) return;

      const dropX = e.clientX - parentRect.left;
      const rawMs = dropX / pxPerMs;
      const positionMs = snapPositionMs(rawMs);

      moveTrack(projectId, track.id, { position_ms: Math.round(positionMs) });
    },
    [pxPerMs, snapPositionMs, moveTrack, projectId, track.id],
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

  // Selection
  const isSelected = localSelection?.type === "timeline_clip" && localSelection.id === track.id;

  const handleClick = useCallback(() => {
    setLocalSelection(
      isSelected ? null : { type: "timeline_clip", id: track.id },
    );
  }, [isSelected, setLocalSelection, track.id]);

  // Check if any remote user has this clip selected
  const remoteSelectors = Object.values(remoteUsers).filter(
    (u) => u.selection?.type === "timeline_clip" && u.selection.id === track.id,
  );

  const borderColor = isSelected
    ? "#6366f1"
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

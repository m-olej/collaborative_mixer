import { create } from "zustand";
import { api } from "../api/rest";
import type { Track, SnapResolution } from "../types/daw";

interface UserCursor {
  color: string;
  cursor_ms: number;
}

interface TimelineState {
  tracks: Track[];
  /** Map of trackId → etag for optimistic locking on updates. */
  etags: Record<number, string>;
  loading: boolean;
  error: string | null;
  zoom: number;
  snapEnabled: boolean;
  snapResolution: SnapResolution;

  /** Local playhead position in ms. */
  playheadMs: number;
  /** Whether the local user is currently playing. */
  playing: boolean;
  /** Per-user cursor positions (remote users). */
  userCursors: Record<string, UserCursor>;
  /** Track IDs currently selected by the local user. */
  selectedTrackIds: Set<number>;
  /** Remote users currently dragging tracks. */
  draggingByUser: Record<string, { color: string; track_ids: number[] }>;

  fetchTracks: (projectId: number) => Promise<void>;
  placeTrack: (
    projectId: number,
    data: { name: string; sample_id?: number; s3_key?: string; lane_index: number; position_ms: number },
  ) => Promise<Track | null>;
  moveTrack: (
    projectId: number,
    trackId: number,
    data: Partial<Pick<Track, "position_ms" | "lane_index">>,
  ) => Promise<Track | null>;
  removeTrack: (projectId: number, trackId: number) => Promise<void>;
  setZoom: (zoom: number) => void;
  setSnap: (enabled: boolean, resolution?: SnapResolution) => void;

  /** Set local playhead position. */
  setPlayheadMs: (ms: number) => void;
  /** Mark local playback as started. */
  setPlaying: (playing: boolean) => void;
  /** Update a remote user's cursor position. */
  setUserCursor: (username: string, color: string, cursorMs: number) => void;
  /** Remove a user's cursor (on leave). */
  removeUserCursor: (username: string) => void;

  /** Select a single track (clears previous selection). */
  selectTrack: (id: number) => void;
  /** Toggle track in selection (for Ctrl+Click). */
  toggleTrackSelection: (id: number) => void;
  /** Clear all selected tracks. */
  clearSelection: () => void;
  /** Batch-move all selected tracks by a delta. */
  batchMoveSelectedTracks: (
    projectId: number,
    deltaMs: number,
    deltaLane: number,
  ) => Promise<void>;
  /** Handle remote drag highlight. */
  setDraggingByUser: (username: string, color: string, trackIds: number[]) => void;
  /** Clear remote drag highlight. */
  clearDraggingByUser: (username: string) => void;

  /** Called from WebSocket broadcast handlers to sync state. */
  handleTrackPlaced: (track: Track) => void;
  handleTrackMoved: (track: Track) => void;
  handleTrackRemoved: (trackId: number) => void;
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  tracks: [],
  etags: {},
  loading: false,
  error: null,
  zoom: 40,
  snapEnabled: true,
  snapResolution: "beat",
  playheadMs: 0,
  playing: false,
  userCursors: {},
  selectedTrackIds: new Set<number>(),
  draggingByUser: {},

  fetchTracks: async (projectId: number) => {
    set({ loading: true, error: null });
    try {
      const tracks = await api.listTracks(projectId);
      set({ tracks, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  placeTrack: async (projectId, data) => {
    try {
      const { track, etag } = await api.createTrack(projectId, data);
      set((s) => ({
        tracks: [...s.tracks, track],
        etags: { ...s.etags, [track.id]: etag },
      }));
      return track;
    } catch (e) {
      set({ error: (e as Error).message });
      return null;
    }
  },

  moveTrack: async (projectId, trackId, data) => {
    const etag = get().etags[trackId] || "";
    try {
      const result = await api.updateTrack(projectId, trackId, data, etag);
      set((s) => ({
        tracks: s.tracks.map((t) => (t.id === trackId ? result.track : t)),
        etags: { ...s.etags, [trackId]: result.etag },
        error: null,
      }));
      return result.track;
    } catch (e) {
      // On 412 conflict, re-fetch all tracks.
      if ((e as Error).message.includes("Conflict")) {
        get().fetchTracks(projectId);
      }
      set({ error: (e as Error).message });
      return null;
    }
  },

  removeTrack: async (projectId, trackId) => {
    try {
      await api.deleteTrack(projectId, trackId);
      set((s) => ({
        tracks: s.tracks.filter((t) => t.id !== trackId),
        etags: Object.fromEntries(
          Object.entries(s.etags).filter(([k]) => Number(k) !== trackId),
        ),
      }));
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  setZoom: (zoom) => set({ zoom }),
  setSnap: (enabled, resolution) =>
    set((s) => ({
      snapEnabled: enabled,
      snapResolution: resolution ?? s.snapResolution,
    })),

  setPlayheadMs: (ms) => set({ playheadMs: ms }),
  setPlaying: (playing) => set({ playing }),
  setUserCursor: (username, color, cursorMs) =>
    set((s) => ({
      userCursors: { ...s.userCursors, [username]: { color, cursor_ms: cursorMs } },
    })),
  removeUserCursor: (username) =>
    set((s) => {
      const { [username]: _, ...rest } = s.userCursors;
      return { userCursors: rest };
    }),

  selectTrack: (id) => set({ selectedTrackIds: new Set([id]) }),
  toggleTrackSelection: (id) =>
    set((s) => {
      const next = new Set(s.selectedTrackIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedTrackIds: next };
    }),
  clearSelection: () => set({ selectedTrackIds: new Set<number>() }),

  batchMoveSelectedTracks: async (projectId, deltaMs, deltaLane) => {
    const { selectedTrackIds, tracks, etags } = get();
    if (selectedTrackIds.size === 0) return;

    const moves = Array.from(selectedTrackIds).map((id) => {
      const track = tracks.find((t) => t.id === id);
      return {
        id,
        position_ms: Math.max(0, Math.round((track?.position_ms ?? 0) + deltaMs)),
        lane_index: Math.max(0, (track?.lane_index ?? 0) + deltaLane),
        etag: etags[id] ?? "",
      };
    });

    try {
      const result = await api.batchMoveTracks(projectId, moves);
      set((s) => {
        let updatedTracks = [...s.tracks];
        const updatedEtags = { ...s.etags };
        for (const t of result.tracks) {
          updatedTracks = updatedTracks.map((existing) =>
            existing.id === t.id ? t : existing,
          );
          updatedEtags[t.id] = result.etags[String(t.id)] ?? "";
        }
        return { tracks: updatedTracks, etags: updatedEtags, error: null };
      });
    } catch (e) {
      if ((e as Error).message.includes("412")) {
        // ETag conflict — re-fetch.
        get().fetchTracks(projectId);
      }
      set({ error: (e as Error).message });
    }
  },

  setDraggingByUser: (username, color, trackIds) =>
    set((s) => ({
      draggingByUser: { ...s.draggingByUser, [username]: { color, track_ids: trackIds } },
    })),
  clearDraggingByUser: (username) =>
    set((s) => {
      const { [username]: _, ...rest } = s.draggingByUser;
      return { draggingByUser: rest };
    }),

  // --- WebSocket sync handlers ---

  handleTrackPlaced: (track) =>
    set((s) => {
      if (s.tracks.some((t) => t.id === track.id)) return s;
      return { tracks: [...s.tracks, track] };
    }),

  handleTrackMoved: (track) =>
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === track.id ? track : t)),
    })),

  handleTrackRemoved: (trackId) =>
    set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== trackId),
    })),
}));

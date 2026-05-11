import { create } from "zustand";
import { api } from "../api/rest";
import type { Track, SnapResolution } from "../types/daw";

interface UserCursor {
  color: string;
  cursor_ms: number;
}

export interface LaneConfig {
  name: string;
  color: string;
}

const DEFAULT_LANE_COLOR = "#374151";

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

  /** Lane metadata (local UI state). */
  laneConfigs: Record<number, LaneConfig>;
  /** Display order of lane indices. */
  laneOrder: number[];

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
  /** Batch-move tracks by a delta. Uses explicit IDs if provided, else selectedTrackIds. */
  batchMoveSelectedTracks: (
    projectId: number,
    deltaMs: number,
    deltaLane: number,
    trackIds?: number[],
  ) => Promise<void>;
  /** Handle remote drag highlight. */
  setDraggingByUser: (username: string, color: string, trackIds: number[]) => void;
  /** Clear remote drag highlight. */
  clearDraggingByUser: (username: string) => void;

  /** Add a new lane, returns its index. */
  addLane: () => number;
  /** Remove a lane. If deleteTracks is true, removes all tracks in it. */
  removeLane: (laneIndex: number, projectId: number, deleteTracks: boolean) => void;
  /** Rename a lane. */
  renameLane: (laneIndex: number, name: string) => void;
  /** Set a lane's color. */
  setLaneColor: (laneIndex: number, color: string) => void;
  /** Set the display order of lanes. */
  setLaneOrder: (order: number[]) => void;
  /** Ensure lane configs cover all track lane indices. */
  syncLanesFromTracks: () => void;

  /** Called from WebSocket broadcast handlers to sync state. */
  handleTrackPlaced: (track: Track) => void;
  handleTrackMoved: (track: Track) => void;
  handleTrackRemoved: (trackId: number) => void;
  /** Apply remote lane config update. */
  handleRemoteLaneUpdate: (configs: Record<number, LaneConfig>, order: number[]) => void;
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
  laneConfigs: { 0: { name: "Lane 1", color: DEFAULT_LANE_COLOR } },
  laneOrder: [0],

  fetchTracks: async (projectId: number) => {
    console.debug(`[Timeline:Store] fetchTracks project=${projectId}`);
    set({ loading: true, error: null });
    try {
      const { tracks, etags: rawEtags } = await api.listTracks(projectId);
      const etags: Record<number, string> = {};
      for (const [k, v] of Object.entries(rawEtags)) {
        etags[Number(k)] = v;
      }
      console.debug(`[Timeline:Store] fetchTracks OK: ${tracks.length} tracks`, tracks);
      set({ tracks, etags, loading: false });
    } catch (e) {
      console.error(`[Timeline:Store] fetchTracks FAILED`, e);
      set({ error: (e as Error).message, loading: false });
    }
  },

  placeTrack: async (projectId, data) => {
    console.debug(`[Timeline:Store] placeTrack project=${projectId}`, data);
    try {
      const { track, etag } = await api.createTrack(projectId, data);
      console.debug(`[Timeline:Store] placeTrack OK id=${track.id} s3_key=${track.s3_key} pos=${track.position_ms}ms lane=${track.lane_index}`);
      set((s) => ({
        tracks: [...s.tracks, track],
        etags: { ...s.etags, [track.id]: etag },
      }));
      return track;
    } catch (e) {
      console.error(`[Timeline:Store] placeTrack FAILED`, e);
      set({ error: (e as Error).message });
      return null;
    }
  },

  moveTrack: async (projectId, trackId, data) => {
    const etag = get().etags[trackId] || "";
    console.debug(`[Timeline:Store] moveTrack project=${projectId} track=${trackId} etag=${etag}`, data);
    try {
      const result = await api.updateTrack(projectId, trackId, data, etag);
      console.debug(`[Timeline:Store] moveTrack OK track=${trackId} new_pos=${result.track.position_ms}ms lane=${result.track.lane_index}`);
      set((s) => ({
        tracks: s.tracks.map((t) => (t.id === trackId ? result.track : t)),
        etags: { ...s.etags, [trackId]: result.etag },
        error: null,
      }));
      return result.track;
    } catch (e) {
      console.error(`[Timeline:Store] moveTrack FAILED track=${trackId}`, e);
      // On 412 conflict, re-fetch all tracks.
      if ((e as Error).message.includes("Conflict")) {
        get().fetchTracks(projectId);
      }
      set({ error: (e as Error).message });
      return null;
    }
  },

  removeTrack: async (projectId, trackId) => {
    console.debug(`[Timeline:Store] removeTrack project=${projectId} track=${trackId}`);
    try {
      await api.deleteTrack(projectId, trackId);
      console.debug(`[Timeline:Store] removeTrack OK track=${trackId}`);
      set((s) => ({
        tracks: s.tracks.filter((t) => t.id !== trackId),
        etags: Object.fromEntries(
          Object.entries(s.etags).filter(([k]) => Number(k) !== trackId),
        ),
      }));
    } catch (e) {
      console.error(`[Timeline:Store] removeTrack FAILED track=${trackId}`, e);
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

  batchMoveSelectedTracks: async (projectId, deltaMs, deltaLane, trackIds) => {
    const { selectedTrackIds, tracks, etags } = get();
    const ids = trackIds ?? Array.from(selectedTrackIds);
    if (ids.length === 0) return;

    const moves = ids.map((id) => {
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

  addLane: () => {
    const { laneOrder, laneConfigs } = get();
    const newIndex = laneOrder.length === 0 ? 0 : Math.max(...laneOrder) + 1;
    console.debug(`[Timeline:Store] addLane index=${newIndex}`);
    set({
      laneConfigs: {
        ...laneConfigs,
        [newIndex]: { name: `Lane ${newIndex + 1}`, color: DEFAULT_LANE_COLOR },
      },
      laneOrder: [...laneOrder, newIndex],
    });
    return newIndex;
  },

  removeLane: (laneIndex, projectId, deleteTracks) => {
    const { tracks, laneOrder, laneConfigs } = get();
    if (deleteTracks) {
      const laneTracks = tracks.filter((t) => t.lane_index === laneIndex);
      for (const t of laneTracks) {
        get().removeTrack(projectId, t.id);
      }
    }
    const { [laneIndex]: _, ...restConfigs } = laneConfigs;
    set({
      laneConfigs: restConfigs,
      laneOrder: laneOrder.filter((i) => i !== laneIndex),
    });
  },

  renameLane: (laneIndex, name) =>
    set((s) => ({
      laneConfigs: {
        ...s.laneConfigs,
        [laneIndex]: { ...s.laneConfigs[laneIndex], name },
      },
    })),

  setLaneColor: (laneIndex, color) =>
    set((s) => ({
      laneConfigs: {
        ...s.laneConfigs,
        [laneIndex]: { ...s.laneConfigs[laneIndex], color },
      },
    })),

  setLaneOrder: (order) => set({ laneOrder: order }),

  syncLanesFromTracks: () => {
    const { tracks, laneConfigs, laneOrder } = get();
    const usedIndices = new Set(tracks.map((t) => t.lane_index));
    let updated = false;
    const newConfigs = { ...laneConfigs };
    const newOrder = [...laneOrder];

    for (const idx of usedIndices) {
      if (!newConfigs[idx]) {
        newConfigs[idx] = { name: `Lane ${idx + 1}`, color: DEFAULT_LANE_COLOR };
        updated = true;
      }
      if (!newOrder.includes(idx)) {
        newOrder.push(idx);
        updated = true;
      }
    }
    // Ensure at least one lane exists
    if (newOrder.length === 0) {
      newConfigs[0] = { name: "Lane 1", color: DEFAULT_LANE_COLOR };
      newOrder.push(0);
      updated = true;
    }

    if (updated) {
      set({ laneConfigs: newConfigs, laneOrder: newOrder });
    }
  },

  // --- WebSocket sync handlers ---

  handleTrackPlaced: (track) =>
    set((s) => {
      if (s.tracks.some((t) => t.id === track.id)) {
        console.debug(`[Timeline:Store] handleTrackPlaced SKIP duplicate id=${track.id}`);
        return s;
      }
      console.debug(`[Timeline:Store] handleTrackPlaced id=${track.id} pos=${track.position_ms}ms lane=${track.lane_index}`);
      return { tracks: [...s.tracks, track] };
    }),

  handleTrackMoved: (track) => {
    console.debug(`[Timeline:Store] handleTrackMoved id=${track.id} pos=${track.position_ms}ms lane=${track.lane_index}`);
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === track.id ? track : t)),
    }));
  },

  handleTrackRemoved: (trackId) => {
    console.debug(`[Timeline:Store] handleTrackRemoved id=${trackId}`);
    set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== trackId),
    }));
  },

  handleRemoteLaneUpdate: (configs, order) =>
    set({ laneConfigs: configs, laneOrder: order }),
}));

import { create } from "zustand";
import { api } from "../api/rest";
import type { Track, SnapResolution } from "../types/daw";

interface TimelineState {
  tracks: Track[];
  /** Map of trackId → etag for optimistic locking on updates. */
  etags: Record<number, string>;
  loading: boolean;
  error: string | null;
  zoom: number;
  snapEnabled: boolean;
  snapResolution: SnapResolution;

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

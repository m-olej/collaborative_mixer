import { Socket, Channel } from "phoenix";
import { create } from "zustand";
import type { MixerState, CollabSelection } from "../types/daw";
import { useCollabStore } from "./useCollabStore";
import { useTimelineStore } from "./useTimelineStore";

/** Callback for feeding decoded audio frames to the visualization. */
export type VisualizationCallback = (fft: Uint8Array, pcm: Float32Array) => void;

interface SocketState {
  socket: Socket | null;
  channel: Channel | null;
  connected: boolean;
  mixerState: MixerState | null;
  /** Set by ProjectWorkspace to wire visualization updates. */
  onVisualizationData: VisualizationCallback | null;
  connect: (projectId: number) => void;
  disconnect: () => void;
  setVisualizationCallback: (cb: VisualizationCallback | null) => void;
  pushCursorMove: (x: number, y: number) => void;
  pushSelectionUpdate: (selection: CollabSelection | null) => void;
}

export const useSocketStore = create<SocketState>((set, get) => ({
  socket: null,
  channel: null,
  connected: false,
  mixerState: null,
  onVisualizationData: null,

  setVisualizationCallback: (cb) => set({ onVisualizationData: cb }),

  connect: (projectId: number) => {
    // Tear down previous connection if any
    get().disconnect();

    const { localUser } = useCollabStore.getState();

    const socket = new Socket("/socket", {});
    socket.connect();

    const channel = socket.channel(`project:${projectId}`, {
      username: localUser.username,
      color: localUser.color,
    });

    channel
      .join()
      .receive("ok", (response: { state: MixerState }) => {
        set({ mixerState: response.state, connected: true });
      })
      .receive("error", (resp: unknown) => {
        console.error("Failed to join channel:", resp);
      });

    // Listen for slider broadcasts from other clients
    channel.on("slider_update", (payload: Record<string, unknown>) => {
      const current = get().mixerState;
      if (!current) return;

      const trackId = payload["track_id"] as string | undefined;
      const volume = payload["volume"] as number | undefined;
      const masterVolume = payload["master_volume"] as number | undefined;
      const pan = payload["pan"] as number | undefined;
      const muted = payload["muted"] as boolean | undefined;
      const solo = payload["solo"] as boolean | undefined;

      if (trackId !== undefined) {
        const trackState = { ...current.tracks[trackId] };
        if (volume !== undefined) trackState.volume = volume;
        if (pan !== undefined) trackState.pan = pan;
        if (muted !== undefined) trackState.muted = muted;
        if (solo !== undefined) trackState.solo = solo;
        set({
          mixerState: {
            ...current,
            tracks: { ...current.tracks, [trackId]: trackState },
          },
        });
      } else if (masterVolume !== undefined) {
        set({ mixerState: { ...current, master_volume: masterVolume } });
      }
    });

    // --- Binary frame handlers (visualization) ---
    const feedViz = (payload: unknown) => {
      if (!(payload instanceof ArrayBuffer)) return;
      const fft = new Uint8Array(payload, 4, 512);
      const pcm = new Float32Array(payload, 516);
      get().onVisualizationData?.(fft, pcm);
    };

    channel.on("audio_buffer", feedViz);
    channel.on("bar_audio", feedViz);
    channel.on("audio_frame", feedViz);
    channel.on("note_audio", (payload: unknown) => {
      if (!(payload instanceof ArrayBuffer)) return;
      const fft = new Uint8Array(payload, 4, 512);
      const pcm = new Float32Array(payload, 516);
      get().onVisualizationData?.(fft, pcm);
    });

    // --- Track broadcast handlers (timeline sync) ---
    channel.on("track_placed", (payload: { track: Record<string, unknown> }) => {
      useTimelineStore.getState().handleTrackPlaced(payload.track as never);
    });
    channel.on("track_moved", (payload: { track: Record<string, unknown> }) => {
      useTimelineStore.getState().handleTrackMoved(payload.track as never);
    });
    channel.on("track_removed", (payload: { track_id: number }) => {
      useTimelineStore.getState().handleTrackRemoved(payload.track_id);
    });

    // --- Presence handlers (collaboration) ---
    channel.on("presence_state", (state: Record<string, unknown>) => {
      const collab = useCollabStore.getState();
      const users: Record<string, { username: string; color: string; cursor: null; selection: null }> = {};
      for (const [username, data] of Object.entries(state)) {
        const metas = (data as { metas: { color: string }[] }).metas;
        if (metas?.[0] && username !== collab.localUser.username) {
          users[username] = {
            username,
            color: metas[0].color,
            cursor: null,
            selection: null,
          };
        }
      }
      collab.setRemoteUsers(users);
    });

    channel.on("presence_diff", (diff: { joins: Record<string, unknown>; leaves: Record<string, unknown> }) => {
      const collab = useCollabStore.getState();
      for (const [username, data] of Object.entries(diff.joins)) {
        if (username === collab.localUser.username) continue;
        const metas = (data as { metas: { color: string }[] }).metas;
        if (metas?.[0]) {
          collab.updateRemoteCursor(username, metas[0].color, 0, 0);
        }
      }
      for (const username of Object.keys(diff.leaves)) {
        collab.removeRemoteUser(username);
      }
    });

    // --- Cursor and selection handlers ---
    channel.on("cursor_move", (payload: { user: string; color: string; x: number; y: number }) => {
      useCollabStore.getState().updateRemoteCursor(payload.user, payload.color, payload.x, payload.y);
    });

    channel.on("selection_update", (payload: { user: string; color: string; selection: CollabSelection | null }) => {
      useCollabStore.getState().updateRemoteSelection(payload.user, payload.color, payload.selection);
    });

    set({ socket, channel });
  },

  disconnect: () => {
    const { channel, socket } = get();
    if (channel) channel.leave();
    if (socket) socket.disconnect();
    set({ socket: null, channel: null, connected: false, mixerState: null });
  },

  pushCursorMove: (x, y) => {
    get().channel?.push("cursor_move", { x, y });
  },

  pushSelectionUpdate: (selection) => {
    get().channel?.push("selection_update", selection ?? {});
  },
}));

import { Socket, Channel } from "phoenix";
import { create } from "zustand";
import type { MixerState, CollabSelection } from "../types/daw";
import { useCollabStore } from "./useCollabStore";
import { useDesignViewStore } from "./useDesignViewStore";
import { useTimelineStore } from "./useTimelineStore";

/** Callback for feeding decoded audio frames to the visualization. */
export type VisualizationCallback = (fft: Uint8Array, pcm: Float32Array) => void;

/** Callback for feeding PCM audio to the AudioWorklet for playback. */
export type AudioDataCallback = (pcm: Float32Array) => void;

interface SocketState {
  socket: Socket | null;
  channel: Channel | null;
  connected: boolean;
  mixerState: MixerState | null;
  /** Set by ProjectWorkspace to wire visualization updates. */
  onVisualizationData: VisualizationCallback | null;
  /** Set by ProjectWorkspace to wire PCM audio to the AudioWorklet. */
  onAudioData: AudioDataCallback | null;
  /** Set by ProjectWorkspace to flush the AudioWorklet ring buffer on seek/stop. */
  onClearAudio: (() => void) | null;
  /** Number of tracks loaded into the engine so far. */
  tracksLoadedCount: number;
  connect: (projectId: number) => void;
  disconnect: () => void;
  setVisualizationCallback: (cb: VisualizationCallback | null) => void;
  setAudioCallback: (cb: AudioDataCallback | null) => void;
  setClearAudioCallback: (cb: (() => void) | null) => void;
  pushCursorMove: (x: number, y: number, view?: string) => void;
  pushSelectionUpdate: (selection: CollabSelection | null) => void;
  pushStartPlayback: (cursorMs: number) => void;
  pushStopPlayback: () => void;
  pushSeek: (cursorMs: number) => void;
  pushLaneUpdate: (configs: Record<number, { name: string; color: string }>, order: number[]) => void;
}

export const useSocketStore = create<SocketState>((set, get) => ({
  socket: null,
  channel: null,
  connected: false,
  mixerState: null,
  onVisualizationData: null,
  onAudioData: null,
  onClearAudio: null,
  tracksLoadedCount: 0,

  setVisualizationCallback: (cb) => set({ onVisualizationData: cb }),
  setAudioCallback: (cb) => set({ onAudioData: cb }),
  setClearAudioCallback: (cb) => set({ onClearAudio: cb }),

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

    // --- Binary frame handlers (visualization + audio playback) ---
    const feedViz = (payload: unknown) => {
      if (!(payload instanceof ArrayBuffer)) return;
      const fft = new Uint8Array(payload, 4, 512);
      const pcm = new Float32Array(payload, 516);
      get().onVisualizationData?.(fft, pcm);
    };

    // Mixer audio frames: feed both visualization AND AudioWorklet for speaker output.
    channel.on("audio_frame", (payload: unknown) => {
      if (!(payload instanceof ArrayBuffer)) {
        console.debug("[Timeline:WS] audio_frame received non-ArrayBuffer", typeof payload);
        return;
      }
      const fft = new Uint8Array(payload, 4, 512);
      const pcm = new Float32Array(payload, 516);
      console.debug(`[Timeline:WS] audio_frame ${payload.byteLength}B, PCM samples=${pcm.length}`);
      get().onVisualizationData?.(fft, pcm);
      get().onAudioData?.(pcm);
    });

    channel.on("audio_buffer", feedViz);
    channel.on("bar_audio", feedViz);
    channel.on("note_audio", (payload: unknown) => {
      if (!(payload instanceof ArrayBuffer)) return;
      const fft = new Uint8Array(payload, 4, 512);
      const pcm = new Float32Array(payload, 516);
      get().onVisualizationData?.(fft, pcm);
    });

    // --- Track broadcast handlers (timeline sync) ---
    channel.on("track_placed", (payload: { track: Record<string, unknown> }) => {
      console.debug("[Timeline:WS] track_placed", payload.track);
      useTimelineStore.getState().handleTrackPlaced(payload.track as never);
    });
    channel.on("track_moved", (payload: { track: Record<string, unknown> }) => {
      console.debug("[Timeline:WS] track_moved", payload.track);
      useTimelineStore.getState().handleTrackMoved(payload.track as never);
    });
    channel.on("track_removed", (payload: { track_id: number }) => {
      console.debug("[Timeline:WS] track_removed id=", payload.track_id);
      useTimelineStore.getState().handleTrackRemoved(payload.track_id);
    });

    // --- Playback lifecycle events ---
    channel.on("playback_ended", () => {
      console.debug("[Timeline:WS] playback_ended");
      useTimelineStore.getState().setPlaying(false);
      get().onClearAudio?.();
    });
    channel.on("playhead_sync", (payload: { cursor_ms: number }) => {
      console.debug("[Timeline:WS] playhead_sync cursor_ms=", payload.cursor_ms);
      useTimelineStore.getState().setPlayheadMs(payload.cursor_ms);
    });
    channel.on("track_loading_progress", (payload: { loaded_count: number }) => {
      console.debug("[Timeline:WS] track_loading_progress loaded=", payload.loaded_count);
      set({ tracksLoadedCount: payload.loaded_count });
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
    channel.on("cursor_move", (payload: { user: string; color: string; x: number; y: number; view?: string }) => {
      useCollabStore.getState().updateRemoteCursor(payload.user, payload.color, payload.x, payload.y, payload.view);
    });

    channel.on("selection_update", (payload: { user: string; color: string; selection: CollabSelection | null }) => {
      useCollabStore.getState().updateRemoteSelection(payload.user, payload.color, payload.selection);
    });

    // --- Keyboard key coloring (Phase 3) ---
    channel.on("key_down", (payload: { user: string; color: string; midi: number }) => {
      useCollabStore.getState().setKeyDown(payload.midi, payload.user, payload.color);
    });
    channel.on("key_up", (payload: { user: string; midi: number }) => {
      useCollabStore.getState().setKeyUp(payload.midi, payload.user);
    });

    // --- Audio sync toggle (Phase 4) ---
    channel.on("sync_update", (payload: { user: string; view_id: string; enabled: boolean }) => {
      void payload;
    });

    // --- Track drag highlight (Phase 6) ---
    channel.on("tracks_dragging", (payload: { user: string; color: string; track_ids: number[] }) => {
      useTimelineStore.getState().setDraggingByUser(payload.user, payload.color, payload.track_ids);
    });
    channel.on("tracks_drag_end", (payload: { user: string }) => {
      useTimelineStore.getState().clearDraggingByUser(payload.user);
    });

    // --- Design view broadcast (Phase 2) ---
    channel.on("design_view_update", (payload: { view_id: string; synth_params: Record<string, unknown> }) => {
      useDesignViewStore.getState().handleRemoteUpdate(
        payload.view_id,
        payload.synth_params as never,
      );
    });

    // --- Lane config sync ---
    channel.on("lane_update", (payload: { lane_configs: Record<string, { name: string; color: string }>; lane_order: number[] }) => {
      console.debug("[Timeline:WS] lane_update", payload);
      const configs: Record<number, { name: string; color: string }> = {};
      for (const [k, v] of Object.entries(payload.lane_configs)) {
        configs[Number(k)] = v;
      }
      useTimelineStore.getState().handleRemoteLaneUpdate(configs, payload.lane_order);
    });

    // Initialize design views from join state once it arrives.
    const unsubMixer = useSocketStore.subscribe((state) => {
      if (state.mixerState?.design_views) {
        useDesignViewStore.getState().initFromServer(
          state.mixerState.design_views as never,
        );
        unsubMixer();
      }
    });

    set({ socket, channel });
  },

  disconnect: () => {
    const { channel, socket } = get();
    if (channel) channel.leave();
    if (socket) socket.disconnect();
    set({ socket: null, channel: null, connected: false, mixerState: null, tracksLoadedCount: 0 });
  },

  pushCursorMove: (x, y, view) => {
    get().channel?.push("cursor_move", { x, y, view });
  },

  pushSelectionUpdate: (selection) => {
    get().channel?.push("selection_update", selection ?? {});
  },

  pushStartPlayback: (cursorMs) => {
    const ch = get().channel;
    if (!ch) return;
    console.debug(`[Timeline:WS] pushStartPlayback cursor=${cursorMs}ms`);
    useTimelineStore.getState().setPlaying(true);
    useTimelineStore.getState().setPlayheadMs(cursorMs);
    ch.push("start_playback", { cursor_ms: cursorMs });
  },

  pushStopPlayback: () => {
    const ch = get().channel;
    if (!ch) return;
    console.debug("[Timeline:WS] pushStopPlayback");
    get().onClearAudio?.();
    useTimelineStore.getState().setPlaying(false);
    ch.push("stop_playback", {});
  },

  pushSeek: (cursorMs) => {
    const ch = get().channel;
    if (!ch) return;
    console.debug(`[Timeline:WS] pushSeek cursor=${cursorMs}ms`);
    get().onClearAudio?.();
    useTimelineStore.getState().setPlayheadMs(cursorMs);
    ch.push("seek", { cursor_ms: cursorMs });
  },

  pushLaneUpdate: (configs, order) => {
    console.debug("[Timeline:WS] pushLaneUpdate", { configs, order });
    get().channel?.push("lane_update", { lane_configs: configs, lane_order: order });
  },
}));

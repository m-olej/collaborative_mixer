import { Socket, Channel } from "phoenix";
import { create } from "zustand";
import type { MixerState } from "../types/daw";

interface SocketState {
  socket: Socket | null;
  channel: Channel | null;
  connected: boolean;
  mixerState: MixerState | null;
  connect: (projectId: number) => void;
  disconnect: () => void;
}

export const useSocketStore = create<SocketState>((set, get) => ({
  socket: null,
  channel: null,
  connected: false,
  mixerState: null,

  connect: (projectId: number) => {
    // Tear down previous connection if any
    get().disconnect();

    const socket = new Socket("/socket", {});
    socket.connect();

    const channel = socket.channel(`project:${projectId}`, {});

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

      if (trackId !== undefined && volume !== undefined) {
        set({
          mixerState: {
            ...current,
            tracks: {
              ...current.tracks,
              [trackId]: {
                ...current.tracks[trackId],
                volume,
              },
            },
          },
        });
      } else if (masterVolume !== undefined) {
        set({ mixerState: { ...current, master_volume: masterVolume } });
      }
    });

    set({ socket, channel });
  },

  disconnect: () => {
    const { channel, socket } = get();
    if (channel) channel.leave();
    if (socket) socket.disconnect();
    set({ socket: null, channel: null, connected: false, mixerState: null });
  },
}));

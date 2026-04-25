import { create } from "zustand";
import type { CollabUser, RemoteUser, CollabSelection } from "../types/daw";

const PRESET_COLORS = [
  "#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6",
  "#8b5cf6", "#ef4444", "#14b8a6", "#f97316", "#06b6d4",
];

function randomColor(): string {
  return PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];
}

function loadLocalUser(): CollabUser {
  if (typeof window === "undefined") return { username: "Anonymous", color: randomColor() };
  const username = localStorage.getItem("daw_username") || "Anonymous";
  let color = localStorage.getItem("daw_user_color");
  if (!color) {
    color = randomColor();
    localStorage.setItem("daw_user_color", color);
  }
  return { username, color };
}

interface CollabState {
  localUser: CollabUser;
  remoteUsers: Record<string, RemoteUser>;
  localSelection: CollabSelection | null;

  setLocalUser: (user: Partial<CollabUser>) => void;
  setRemoteUsers: (users: Record<string, RemoteUser>) => void;
  updateRemoteCursor: (username: string, color: string, x: number, y: number) => void;
  updateRemoteSelection: (username: string, color: string, selection: CollabSelection | null) => void;
  removeRemoteUser: (username: string) => void;
  setLocalSelection: (selection: CollabSelection | null) => void;
}

export const useCollabStore = create<CollabState>((set) => ({
  localUser: loadLocalUser(),
  remoteUsers: {},
  localSelection: null,

  setLocalUser: (updates) =>
    set((s) => {
      const user = { ...s.localUser, ...updates };
      localStorage.setItem("daw_username", user.username);
      localStorage.setItem("daw_user_color", user.color);
      return { localUser: user };
    }),

  setRemoteUsers: (users) => set({ remoteUsers: users }),

  updateRemoteCursor: (username, color, x, y) =>
    set((s) => ({
      remoteUsers: {
        ...s.remoteUsers,
        [username]: {
          ...s.remoteUsers[username],
          username,
          color,
          cursor: { x, y },
          selection: s.remoteUsers[username]?.selection ?? null,
        },
      },
    })),

  updateRemoteSelection: (username, color, selection) =>
    set((s) => ({
      remoteUsers: {
        ...s.remoteUsers,
        [username]: {
          ...s.remoteUsers[username],
          username,
          color,
          cursor: s.remoteUsers[username]?.cursor ?? null,
          selection,
        },
      },
    })),

  removeRemoteUser: (username) =>
    set((s) => {
      const { [username]: _, ...rest } = s.remoteUsers;
      return { remoteUsers: rest };
    }),

  setLocalSelection: (selection) => set({ localSelection: selection }),
}));

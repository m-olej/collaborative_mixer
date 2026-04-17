import { create } from "zustand";
import type { Project } from "../types/daw";
import { api } from "../api/rest";

interface ProjectState {
  projects: Project[];
  loading: boolean;
  error: string | null;
  fetchProjects: () => Promise<void>;
  createProject: (name: string, bpm: number) => Promise<Project>;
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  loading: false,
  error: null,

  fetchProjects: async () => {
    set({ loading: true, error: null });
    try {
      const projects = await api.listProjects();
      set({ projects, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  createProject: async (name: string, bpm: number) => {
    const project = await api.createProject(name, bpm);
    set((state) => ({ projects: [...state.projects, project] }));
    return project;
  },
}));

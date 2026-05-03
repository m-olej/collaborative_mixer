import { create } from "zustand";
import type { Project } from "../types/daw";
import { api } from "../api/rest";

interface ProjectState {
  projects: Project[];
  loading: boolean;
  error: string | null;
  fetchProjects: () => Promise<void>;
  createProject: (name: string, bpm: number) => Promise<Project>;
  updateProject: (id: number, data: Partial<Project>, etag: string) => Promise<Project>;
  deleteProject: (id: number) => Promise<void>;
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

  updateProject: async (id: number, data: Partial<Project>, etag: string) => {
    const updated = await api.updateProject(id, data, etag);
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? updated : p)),
    }));
    return updated;
  },

  deleteProject: async (id: number) => {
    await api.deleteProject(id);
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
    }));
  },
}));

import type { Project, Sample, PaginatedResponse } from "../types/daw";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });

  if (!res.ok) {
    throw new Error(`API ${res.status}: ${res.statusText}`);
  }

  // 204 No Content or 202 Accepted with no body
  if (res.status === 204 || res.status === 202) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

export const api = {
  // --- Projects ---

  listProjects: async (): Promise<Project[]> => {
    const body = await request<{ data: Project[] }>("/projects");
    return body.data;
  },

  getProject: async (id: number): Promise<{ project: Project; etag: string }> => {
    const res = await fetch(`${BASE}/projects/${id}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const body = (await res.json()) as { data: Project };
    const etag = res.headers.get("etag") ?? "";
    return { project: body.data, etag };
  },

  createProject: async (name: string, bpm: number): Promise<Project> => {
    const body = await request<{ data: Project }>("/projects", {
      method: "POST",
      body: JSON.stringify({ project: { name, bpm } }),
    });
    return body.data;
  },

  updateProject: async (
    id: number,
    data: Partial<Pick<Project, "name" | "bpm" | "time_signature" | "count_in_note_value">>,
    etag: string,
  ): Promise<Project> => {
    const res = await fetch(`${BASE}/projects/${id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": etag,
      },
      body: JSON.stringify({ project: data }),
    });
    if (res.status === 412) throw new Error("Conflict: project was modified by another user.");
    if (res.status === 428) throw new Error("ETag required for update.");
    if (!res.ok) throw new Error(`API ${res.status}`);
    const body = (await res.json()) as { data: Project };
    return body.data;
  },

  deleteProject: async (id: number): Promise<void> => {
    await request<void>(`/projects/${id}`, { method: "DELETE" });
  },

  // --- Samples (paginated) ---

  listSamples: async (page = 1, limit = 50): Promise<PaginatedResponse<Sample>> => {
    return request<PaginatedResponse<Sample>>(`/samples?page=${page}&limit=${limit}`);
  },

  deleteSample: async (id: number): Promise<void> => {
    await request<void>(`/samples/${id}`, { method: "DELETE" });
  },

  // --- Exports (idempotent) ---

  startExport: async (projectId: number, token: string): Promise<number> => {
    const res = await fetch(`${BASE}/projects/${projectId}/exports?token=${token}`, {
      method: "POST",
    });
    // 202 Accepted — job started or already running
    // 303 See Other — completed, location header has the result URL
    if (res.status === 202 || res.status === 303) return res.status;
    throw new Error(`Export failed: ${res.status}`);
  },
};

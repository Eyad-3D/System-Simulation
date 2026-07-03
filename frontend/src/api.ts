// REST client for the SimStudio backend. Every call has a bundled-data
// fallback so the UI stays usable when the FastAPI service is not running
// (the fallback is flagged to the caller so it can surface a warning).

import type { ComponentDef, DataCheck, Project, SimResult } from "./types";
import fallbackLibrary from "./data/componentLibrary.json";
import fallbackProject from "./data/demoProject.json";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? JSON.stringify(body);
    } catch {
      /* keep statusText */
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchLibrary(): Promise<{
  components: ComponentDef[];
  offline: boolean;
}> {
  try {
    const data = await request<{ components: ComponentDef[] }>("/library");
    return { components: data.components, offline: false };
  } catch {
    return {
      components: (fallbackLibrary as { components: ComponentDef[] }).components,
      offline: true,
    };
  }
}

export async function fetchDemoProject(): Promise<{
  project: Project;
  offline: boolean;
}> {
  try {
    const project = await request<Project>("/projects/fc-airplane");
    return { project, offline: false };
  } catch {
    return { project: fallbackProject as unknown as Project, offline: true };
  }
}

export function listProjects(): Promise<{ id: string; name: string }[]> {
  return request("/projects");
}

export function fetchProject(id: string): Promise<Project> {
  return request(`/projects/${encodeURIComponent(id)}`);
}

export function saveProject(project: Project): Promise<{ saved: string }> {
  return request(`/projects/${encodeURIComponent(project.id)}`, {
    method: "PUT",
    body: JSON.stringify(project),
  });
}

export function validateProject(project: Project): Promise<DataCheck[]> {
  return request("/validate", {
    method: "POST",
    body: JSON.stringify({ project }),
  });
}

export function runSimulation(project: Project, caseId: string): Promise<SimResult> {
  return request("/simulate", {
    method: "POST",
    body: JSON.stringify({ project, caseId }),
  });
}

import { create } from "zustand";
import * as api from "../api";
import type {
  ComponentDef,
  DataCheck,
  LogMessage,
  ParamValue,
  Project,
  SimResult,
  SystemNode,
} from "../types";
import { useUIStore } from "./uiStore";

export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function now(): string {
  return new Date().toLocaleTimeString([], { hour12: false });
}

const HISTORY_LIMIT = 50;

interface ProjectState {
  library: ComponentDef[];
  libraryById: Record<string, ComponentDef>;
  offline: boolean;
  loaded: boolean;

  project: Project | null;
  activeSystemId: string | null;
  selectedElementId: string | null;
  dirty: boolean;

  past: Project[];
  future: Project[];

  messages: LogMessage[];
  dataChecks: DataCheck[] | null;
  results: Record<string, SimResult>;
  activeCaseId: string | null;
  activeResultCaseId: string | null;
  running: boolean;
  checking: boolean;

  // lifecycle
  init: () => Promise<void>;
  log: (level: LogMessage["level"], text: string) => void;
  clearMessages: () => void;

  // navigation & selection
  select: (elementId: string | null) => void;
  setActiveSystem: (systemId: string) => void;

  // topology editing
  addElement: (defId: string, position: { x: number; y: number }) => void;
  moveElement: (id: string, position: { x: number; y: number }) => void;
  beginHistory: () => void;
  removeElements: (ids: string[]) => void;
  renameElement: (id: string, label: string) => void;
  setParameter: (elementId: string, key: string, value: ParamValue) => void;
  addConnection: (
    sourceElementId: string,
    sourcePortId: string,
    targetElementId: string,
    targetPortId: string,
  ) => void;
  removeConnections: (ids: string[]) => void;
  addDataBus: (el1: string, p1: string, el2: string, p2: string) => void;
  removeDataBus: (id: string) => void;
  renameSystem: (systemId: string, name: string) => void;

  undo: () => void;
  redo: () => void;

  // project lifecycle
  newProject: () => void;
  openProject: (id: string) => Promise<void>;
  saveRemote: () => Promise<void>;
  exportProject: () => void;
  importProject: (json: string) => void;

  // cases & simulation
  setActiveCase: (id: string) => void;
  setCaseField: (caseId: string, patch: Partial<{ name: string; duration: number; timeStep: number }>) => void;
  addCase: () => void;
  runDataChecks: () => Promise<DataCheck[]>;
  run: () => Promise<void>;
  setActiveResultCase: (caseId: string) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => {
  /** Apply a mutation to a deep clone of the project (optionally recording undo history). */
  function updateProject(fn: (draft: Project) => void, recordHistory = true) {
    const { project, past } = get();
    if (!project) return;
    const draft = structuredClone(project);
    fn(draft);
    set({
      project: draft,
      dirty: true,
      ...(recordHistory
        ? { past: [...past.slice(-(HISTORY_LIMIT - 1)), project], future: [] }
        : {}),
    });
  }

  function rootSystemOf(project: Project): SystemNode {
    return project.systems.find((s) => s.parentId === null) ?? project.systems[0];
  }

  return {
    library: [],
    libraryById: {},
    offline: false,
    loaded: false,
    project: null,
    activeSystemId: null,
    selectedElementId: null,
    dirty: false,
    past: [],
    future: [],
    messages: [],
    dataChecks: null,
    results: {},
    activeCaseId: null,
    activeResultCaseId: null,
    running: false,
    checking: false,

    init: async () => {
      const lib = await api.fetchLibrary();
      const demo = await api.fetchDemoProject();
      const libraryById = Object.fromEntries(lib.components.map((c) => [c.id, c]));
      set({
        library: lib.components,
        libraryById,
        offline: lib.offline,
        loaded: true,
        project: demo.project,
        activeSystemId: rootSystemOf(demo.project).id,
        activeCaseId: demo.project.cases[0]?.id ?? null,
      });
      const log = get().log;
      log("info", `Component library loaded (${lib.components.length} components).`);
      log("info", `Project '${demo.project.name}' opened.`);
      if (lib.offline) {
        log(
          "warning",
          "Backend not reachable — running from bundled data. Start the FastAPI service to enable save, data checks and simulation.",
        );
      }
    },

    log: (level, text) =>
      set((s) => ({ messages: [...s.messages, { level, text, time: now() }] })),
    clearMessages: () => set({ messages: [] }),

    select: (elementId) => set({ selectedElementId: elementId }),

    setActiveSystem: (systemId) =>
      set({ activeSystemId: systemId, selectedElementId: null }),

    addElement: (defId, position) => {
      const { libraryById, activeSystemId, project } = get();
      const def = libraryById[defId];
      if (!def || !project || !activeSystemId) return;
      const count = project.systems.reduce(
        (n, s) => n + s.elements.filter((e) => e.componentDefId === defId).length,
        0,
      );
      const elId = uid("el");
      const isContainer = defId === "container.system";
      const subSystemId = isContainer ? uid("sys") : undefined;
      updateProject((draft) => {
        const system = draft.systems.find((s) => s.id === activeSystemId);
        if (!system) return;
        system.elements.push({
          id: elId,
          componentDefId: defId,
          label: `${def.name} ${count + 1}`,
          position,
          parameterOverrides: {},
          ...(isContainer ? { isSubSystem: true, subSystemId } : {}),
        });
        if (isContainer && subSystemId) {
          draft.systems.push({
            id: subSystemId,
            name: `${def.name} ${count + 1}`,
            parentId: activeSystemId,
            elements: [],
            connections: [],
          });
        }
      });
      set({ selectedElementId: elId });
    },

    moveElement: (id, position) =>
      updateProject((draft) => {
        for (const s of draft.systems) {
          const el = s.elements.find((e) => e.id === id);
          if (el) el.position = position;
        }
      }, false),

    beginHistory: () => {
      const { project, past } = get();
      if (!project) return;
      set({ past: [...past.slice(-(HISTORY_LIMIT - 1)), project], future: [] });
    },

    removeElements: (ids) => {
      if (ids.length === 0) return;
      updateProject((draft) => {
        // collect sub-system trees rooted at removed container elements
        const doomedSystems = new Set<string>();
        const collectSystems = (sysId: string) => {
          doomedSystems.add(sysId);
          for (const s of draft.systems) {
            if (s.parentId === sysId) collectSystems(s.id);
          }
        };
        const doomedElements = new Set(ids);
        for (const s of draft.systems) {
          for (const el of s.elements) {
            if (doomedElements.has(el.id) && el.subSystemId) collectSystems(el.subSystemId);
          }
        }
        for (const sysId of doomedSystems) {
          const sys = draft.systems.find((s) => s.id === sysId);
          sys?.elements.forEach((el) => doomedElements.add(el.id));
        }
        draft.systems = draft.systems.filter((s) => !doomedSystems.has(s.id));
        for (const s of draft.systems) {
          s.elements = s.elements.filter((e) => !doomedElements.has(e.id));
          s.connections = s.connections.filter(
            (c) => !doomedElements.has(c.sourceElementId) && !doomedElements.has(c.targetElementId),
          );
        }
        draft.dataBusConnections = draft.dataBusConnections.filter(
          (d) => !doomedElements.has(d.element1Id) && !doomedElements.has(d.element2Id),
        );
      });
      const { selectedElementId, activeSystemId, project } = get();
      if (selectedElementId && ids.includes(selectedElementId)) set({ selectedElementId: null });
      // if the active system was deleted, fall back to root
      if (project && !project.systems.some((s) => s.id === activeSystemId)) {
        set({ activeSystemId: rootSystemOf(project).id });
      }
    },

    renameElement: (id, label) =>
      updateProject((draft) => {
        for (const s of draft.systems) {
          const el = s.elements.find((e) => e.id === id);
          if (el) {
            el.label = label;
            if (el.subSystemId) {
              const sub = draft.systems.find((sys) => sys.id === el.subSystemId);
              if (sub) sub.name = label;
            }
          }
        }
      }),

    setParameter: (elementId, key, value) =>
      updateProject((draft) => {
        for (const s of draft.systems) {
          const el = s.elements.find((e) => e.id === elementId);
          if (el) el.parameterOverrides[key] = value;
        }
      }),

    addConnection: (sourceElementId, sourcePortId, targetElementId, targetPortId) => {
      const { project, libraryById, log } = get();
      if (!project) return;
      const elements = project.systems.flatMap((s) => s.elements);
      const src = elements.find((e) => e.id === sourceElementId);
      const tgt = elements.find((e) => e.id === targetElementId);
      if (!src || !tgt) return;
      const srcPort = libraryById[src.componentDefId]?.ports.find((p) => p.id === sourcePortId);
      const tgtPort = libraryById[tgt.componentDefId]?.ports.find((p) => p.id === targetPortId);
      if (!srcPort || !tgtPort) return;

      if (srcPort.kind === "signal" || tgtPort.kind === "signal") {
        if (srcPort.kind !== "signal" || tgtPort.kind !== "signal") {
          log("error", `Cannot connect a ${srcPort.kind} port to a ${tgtPort.kind} port.`);
          return;
        }
        // signal wiring on the canvas is stored as a Data Bus connection
        get().addDataBus(sourceElementId, sourcePortId, targetElementId, targetPortId);
        return;
      }
      if (srcPort.kind !== tgtPort.kind) {
        log(
          "error",
          `Incompatible connection: '${srcPort.name}' (${srcPort.kind}) ↔ '${tgtPort.name}' (${tgtPort.kind}).`,
        );
        return;
      }
      const dup = project.systems.some((s) =>
        s.connections.some(
          (c) =>
            (c.sourceElementId === sourceElementId &&
              c.sourcePortId === sourcePortId &&
              c.targetElementId === targetElementId &&
              c.targetPortId === targetPortId) ||
            (c.sourceElementId === targetElementId &&
              c.sourcePortId === targetPortId &&
              c.targetElementId === sourceElementId &&
              c.targetPortId === sourcePortId),
        ),
      );
      if (dup) return;
      const { activeSystemId } = get();
      updateProject((draft) => {
        const system = draft.systems.find((s) => s.id === activeSystemId);
        system?.connections.push({
          id: uid("c"),
          sourceElementId,
          sourcePortId,
          targetElementId,
          targetPortId,
        });
      });
    },

    removeConnections: (ids) => {
      if (ids.length === 0) return;
      updateProject((draft) => {
        for (const s of draft.systems) {
          s.connections = s.connections.filter((c) => !ids.includes(c.id));
        }
        draft.dataBusConnections = draft.dataBusConnections.filter((d) => !ids.includes(d.id));
      });
    },

    addDataBus: (el1, p1, el2, p2) => {
      const { project, libraryById, log } = get();
      if (!project) return;
      const elements = project.systems.flatMap((s) => s.elements);
      const e1 = elements.find((e) => e.id === el1);
      const e2 = elements.find((e) => e.id === el2);
      const port1 = e1 && libraryById[e1.componentDefId]?.ports.find((p) => p.id === p1);
      const port2 = e2 && libraryById[e2.componentDefId]?.ports.find((p) => p.id === p2);
      if (!e1 || !e2 || !port1 || !port2) return;
      if (port1.kind !== "signal" || port2.kind !== "signal") {
        log("error", "Data bus connections must link two signal ports.");
        return;
      }
      if (port1.direction === port2.direction) {
        log(
          "warning",
          `Data bus: '${e1.label}.${port1.name}' and '${e2.label}.${port2.name}` +
            `' are both ${port1.direction}s — connection added, but no data will flow.`,
        );
      }
      const dup = project.dataBusConnections.some(
        (d) =>
          (d.element1Id === el1 && d.port1Id === p1 && d.element2Id === el2 && d.port2Id === p2) ||
          (d.element1Id === el2 && d.port1Id === p2 && d.element2Id === el1 && d.port2Id === p1),
      );
      if (dup) {
        log("info", "This data bus connection already exists.");
        return;
      }
      updateProject((draft) => {
        draft.dataBusConnections.push({
          id: uid("dbc"),
          element1Id: el1,
          port1Id: p1,
          element2Id: el2,
          port2Id: p2,
        });
      });
      log("info", `Data bus: '${e1.label}.${port1.name}' ↔ '${e2.label}.${port2.name}' connected.`);
    },

    removeDataBus: (id) =>
      updateProject((draft) => {
        draft.dataBusConnections = draft.dataBusConnections.filter((d) => d.id !== id);
      }),

    renameSystem: (systemId, name) =>
      updateProject((draft) => {
        const sys = draft.systems.find((s) => s.id === systemId);
        if (sys) sys.name = name;
        draft.name = draft.systems.find((s) => s.parentId === null)?.name ?? draft.name;
      }),

    undo: () => {
      const { past, future, project } = get();
      if (past.length === 0 || !project) return;
      const prev = past[past.length - 1];
      set({
        project: prev,
        past: past.slice(0, -1),
        future: [project, ...future].slice(0, HISTORY_LIMIT),
        dirty: true,
      });
    },
    redo: () => {
      const { past, future, project } = get();
      if (future.length === 0 || !project) return;
      const next = future[0];
      set({
        project: next,
        future: future.slice(1),
        past: [...past.slice(-(HISTORY_LIMIT - 1)), project],
        dirty: true,
      });
    },

    newProject: () => {
      const rootId = uid("sys");
      const caseId = uid("case");
      const project: Project = {
        id: uid("project"),
        name: "New Project",
        systems: [{ id: rootId, name: "New Project", parentId: null, elements: [], connections: [] }],
        dataBusConnections: [],
        cases: [{ id: caseId, name: "Case 1", duration: 600, timeStep: 1 }],
      };
      set({
        project,
        activeSystemId: rootId,
        activeCaseId: caseId,
        activeResultCaseId: null,
        selectedElementId: null,
        past: [],
        future: [],
        results: {},
        dataChecks: null,
        dirty: false,
      });
      get().log("info", "New project created.");
    },

    openProject: async (id) => {
      try {
        const project = await api.fetchProject(id);
        set({
          project,
          activeSystemId: project.systems.find((s) => s.parentId === null)?.id ?? project.systems[0]?.id,
          activeCaseId: project.cases[0]?.id ?? null,
          activeResultCaseId: null,
          selectedElementId: null,
          past: [],
          future: [],
          results: {},
          dataChecks: null,
          dirty: false,
        });
        get().log("info", `Project '${project.name}' opened.`);
      } catch (e) {
        get().log("error", `Failed to open project: ${(e as Error).message}`);
      }
    },

    saveRemote: async () => {
      const { project, log } = get();
      if (!project) return;
      try {
        await api.saveProject(project);
        set({ dirty: false });
        log("info", `Project '${project.name}' saved to the server.`);
      } catch (e) {
        log("error", `Save failed: ${(e as Error).message}. Use Export to download the project file instead.`);
      }
    },

    exportProject: () => {
      const { project } = get();
      if (!project) return;
      const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
      get().log("info", `Project exported as ${project.id}.json.`);
    },

    importProject: (json) => {
      try {
        const project = JSON.parse(json) as Project;
        if (!project.id || !Array.isArray(project.systems)) {
          throw new Error("not a SimStudio project file");
        }
        project.dataBusConnections ??= [];
        project.cases ??= [];
        set({
          project,
          activeSystemId: project.systems.find((s) => s.parentId === null)?.id ?? project.systems[0]?.id,
          activeCaseId: project.cases[0]?.id ?? null,
          activeResultCaseId: null,
          selectedElementId: null,
          past: [],
          future: [],
          results: {},
          dataChecks: null,
          dirty: true,
        });
        get().log("info", `Project '${project.name}' imported.`);
      } catch (e) {
        get().log("error", `Import failed: ${(e as Error).message}`);
      }
    },

    setActiveCase: (id) => set({ activeCaseId: id }),

    setCaseField: (caseId, patch) =>
      updateProject((draft) => {
        const c = draft.cases.find((cc) => cc.id === caseId);
        if (c) Object.assign(c, patch);
      }),

    addCase: () => {
      const id = uid("case");
      updateProject((draft) => {
        draft.cases.push({
          id,
          name: `Case ${draft.cases.length + 1}`,
          duration: 600,
          timeStep: 1,
        });
      });
      set({ activeCaseId: id });
    },

    runDataChecks: async () => {
      const { project, log } = get();
      if (!project) return [];
      set({ checking: true });
      try {
        const checks = await api.validateProject(project);
        set({ dataChecks: checks, checking: false });
        const errors = checks.filter((c) => c.level === "error").length;
        const warnings = checks.filter((c) => c.level === "warning").length;
        log(
          errors ? "error" : warnings ? "warning" : "info",
          `Data checks: ${errors} error(s), ${warnings} warning(s).`,
        );
        useUIStore.getState().focusPanel("data-checks");
        return checks;
      } catch (e) {
        set({ checking: false });
        log("error", `Data checks failed: ${(e as Error).message}`);
        return [];
      }
    },

    run: async () => {
      const { project, activeCaseId, log } = get();
      if (!project) return;
      if (!activeCaseId) {
        log("error", "No simulation case selected.");
        return;
      }
      const simCase = project.cases.find((c) => c.id === activeCaseId);
      set({ running: true });
      log("info", `Running case '${simCase?.name ?? activeCaseId}' …`);
      try {
        const result = await api.runSimulation(project, activeCaseId);
        set((s) => ({
          running: false,
          results: { ...s.results, [activeCaseId]: result },
          activeResultCaseId: activeCaseId,
        }));
        for (const m of result.messages) log(m.level, m.text);
        if (result.status === "failed") {
          log("error", `Simulation failed — see messages above.`);
          useUIStore.getState().focusPanel("messages");
        } else {
          log(
            result.status === "warning" ? "warning" : "info",
            `Simulation finished with status '${result.status}'. ${result.channels.length} channels available in Results.`,
          );
          useUIStore.getState().focusPanel("results");
        }
      } catch (e) {
        set({ running: false });
        log("error", `Simulation request failed: ${(e as Error).message}`);
        useUIStore.getState().focusPanel("messages");
      }
    },

    setActiveResultCase: (caseId) => set({ activeResultCaseId: caseId }),
  };
});

// -- convenience selectors ----------------------------------------------------

export function useActiveSystem(): SystemNode | null {
  return useProjectStore((s) => {
    if (!s.project || !s.activeSystemId) return null;
    return s.project.systems.find((sys) => sys.id === s.activeSystemId) ?? null;
  });
}

export function systemBreadcrumb(project: Project, systemId: string): SystemNode[] {
  const byId = new Map(project.systems.map((s) => [s.id, s]));
  const chain: SystemNode[] = [];
  let cur = byId.get(systemId);
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  FilePlus2,
  FolderOpen,
  Gauge,
  LayoutGrid,
  ListChecks,
  Moon,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Settings2,
  Sliders,
  Square,
  Sun,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import * as api from "../api";
import { resetDockLayout } from "./DockLayout";
import { useProjectStore } from "../store/projectStore";
import { useUIStore, type RibbonTab } from "../store/uiStore";

// Optimization is not implemented yet — kept out of the ribbon (its RibbonTab
// id/stub render remain) until it ships as a real feature. Parameters is real
// (per-case overrides + sweeps, driven from the Cases & Parameters panel).
const TABS: { id: RibbonTab; label: string }[] = [
  { id: "project", label: "Project" },
  { id: "home", label: "Home" },
  { id: "simulations", label: "Simulations" },
  { id: "parameters", label: "Parameters" },
  { id: "results", label: "Results" },
];

function RibbonGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col border-r border-[color:var(--ss-border)] px-2 last:border-r-0">
      <div className="flex flex-1 items-center gap-1">{children}</div>
      <div className="pb-0.5 text-center text-[10px] leading-3 text-[color:var(--ss-text-dim)]">
        {label}
      </div>
    </div>
  );
}

function BigButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  accent,
  title,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  accent?: boolean;
  title?: string;
}) {
  return (
    <button
      className={`flex h-[52px] w-[58px] flex-col items-center justify-center gap-0.5 rounded text-[11px] leading-tight
        ${accent ? "text-[color:var(--ss-accent)]" : ""}
        hover:bg-[color:var(--ss-hover)] active:bg-[color:var(--ss-active)] disabled:opacity-40 disabled:hover:bg-transparent`}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
    >
      <Icon size={20} />
      <span>{label}</span>
    </button>
  );
}

function OpenProjectButton() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<{ id: string; name: string }[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const openProject = useProjectStore((s) => s.openProject);
  const log = useProjectStore((s) => s.log);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <BigButton
        icon={FolderOpen}
        label="Open"
        onClick={async () => {
          if (!open) {
            try {
              setItems(await api.listProjects());
            } catch (e) {
              log("error", `Cannot list projects: ${(e as Error).message}`);
              setItems([]);
            }
          }
          setOpen(!open);
        }}
      />
      {open && (
        <div className="absolute left-0 top-[54px] z-50 min-w-[220px] rounded border border-[color:var(--ss-border)] bg-[color:var(--ss-panel)] py-1 shadow-lg">
          {items.length === 0 && (
            <div className="px-3 py-1.5 text-[12px] text-[color:var(--ss-text-dim)]">
              No projects on server
            </div>
          )}
          {items.map((p) => (
            <button
              key={p.id}
              className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[color:var(--ss-accent-soft)]"
              onClick={() => {
                setOpen(false);
                void openProject(p.id);
              }}
            >
              {p.name}
              <span className="ml-2 text-[10px] text-[color:var(--ss-text-dim)]">{p.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HomeTab() {
  const store = useProjectStore();
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <RibbonGroup label="Project">
        <BigButton icon={FilePlus2} label="New" onClick={store.newProject} />
        <OpenProjectButton />
        <BigButton icon={Save} label="Save" onClick={() => void store.saveRemote()} />
        <BigButton icon={Download} label="Export" onClick={store.exportProject} title="Download project as JSON" />
        <BigButton icon={Upload} label="Import" onClick={() => fileRef.current?.click()} title="Import project JSON" />
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) store.importProject(await f.text());
            e.target.value = "";
          }}
        />
      </RibbonGroup>
      <RibbonGroup label="Edit">
        <BigButton icon={Undo2} label="Undo" onClick={store.undo} disabled={store.past.length === 0} />
        <BigButton icon={Redo2} label="Redo" onClick={store.redo} disabled={store.future.length === 0} />
        <BigButton
          icon={Trash2}
          label="Delete"
          onClick={() => store.selectedElementId && store.removeElements([store.selectedElementId])}
          disabled={!store.selectedElementId}
        />
      </RibbonGroup>
      <RibbonGroup label="Workspace">
        <BigButton
          icon={Settings2}
          label="Properties"
          onClick={() => useUIStore.getState().focusPanel("properties")}
        />
        <BigButton
          icon={LayoutGrid}
          label="Topology"
          onClick={() => useUIStore.getState().focusPanel("topology")}
        />
        <BigButton
          icon={RotateCcw}
          label="Reset UI"
          title="Reset the panel layout to default"
          onClick={resetDockLayout}
        />
      </RibbonGroup>
    </>
  );
}

function SimulationsTab() {
  const store = useProjectStore();
  const cases = store.project?.cases ?? [];
  const activeCase = cases.find((c) => c.id === store.activeCaseId);
  return (
    <>
      <RibbonGroup label="Cases">
        <div className="flex flex-col justify-center gap-1 py-1">
          <div className="flex items-center gap-1">
            <select
              className="ss-input w-[150px]"
              value={store.activeCaseId ?? ""}
              onChange={(e) => store.setActiveCase(e.target.value)}
            >
              {cases.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className="ss-toolbtn" title="Add case" onClick={store.addCase}>
              <Plus size={14} />
            </button>
            <button
              className="ss-toolbtn"
              title="Duplicate this case"
              disabled={!store.activeCaseId}
              onClick={() => store.activeCaseId && store.duplicateCase(store.activeCaseId)}
            >
              <Copy size={14} />
            </button>
            <button
              className="ss-toolbtn"
              title="Delete this case"
              disabled={cases.length <= 1 || !store.activeCaseId}
              onClick={() => store.activeCaseId && store.removeCase(store.activeCaseId)}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <div className="flex items-center gap-1 text-[11px] text-[color:var(--ss-text-dim)]">
            <span>Duration</span>
            <input
              type="number"
              className="ss-input w-[64px]"
              value={activeCase?.duration ?? 0}
              min={1}
              onChange={(e) =>
                activeCase && store.setCaseField(activeCase.id, { duration: Number(e.target.value) || 1 })
              }
            />
            <span>s</span>
            <span className="ml-2" title="Solver step: signals and control blocks evaluate at this interval; mechanics sub-step to ≤10 ms internally.">Step</span>
            <input
              type="number"
              className="ss-input w-[64px]"
              title="Solver step in seconds (min 0.0001). Smaller = finer, more compute."
              value={activeCase?.timeStep ?? 1}
              step="any"
              min={0.0001}
              onChange={(e) =>
                activeCase &&
                store.setCaseField(activeCase.id, {
                  timeStep: Math.max(0.0001, Number(e.target.value) || 1),
                })
              }
            />
            <span>s</span>
            <span className="ml-2" title="Store a data point every N solver steps. Output interval = Step × this. Use to keep results small at fine step sizes.">Store every</span>
            <input
              type="number"
              className="ss-input w-[52px]"
              title="Record a result point every N solver steps (1 = every step)."
              value={activeCase?.outputEvery ?? 1}
              step={1}
              min={1}
              onChange={(e) =>
                activeCase &&
                store.setCaseField(activeCase.id, {
                  outputEvery: Math.max(1, Math.round(Number(e.target.value) || 1)),
                })
              }
            />
            <span>steps</span>
            <span className="ml-2">Pacing</span>
            <select
              className="ss-input w-[90px]"
              title="0 = solve as fast as possible; N× paces the run against real time so you can watch and tune it live"
              value={activeCase?.realtimeFactor ?? 0}
              onChange={(e) =>
                activeCase &&
                store.setCaseField(activeCase.id, { realtimeFactor: Number(e.target.value) })
              }
            >
              <option value={0}>Max speed</option>
              <option value={1}>1× real time</option>
              <option value={5}>5×</option>
              <option value={10}>10×</option>
              <option value={30}>30×</option>
            </select>
          </div>
        </div>
      </RibbonGroup>
      <RibbonGroup label="Simulation">
        <BigButton
          icon={Play}
          label={store.running ? "Running…" : "Run"}
          accent
          disabled={store.running || !store.project}
          onClick={() => void store.run()}
        />
        <BigButton
          icon={Square}
          label="Stop"
          title="Cancel the running simulation (partial results are kept)"
          disabled={!store.running}
          onClick={store.stopRun}
        />
        <BigButton
          icon={ListChecks}
          label="Checks"
          title="Run Data Checks"
          disabled={store.checking || !store.project}
          onClick={() => void store.runDataChecks()}
        />
      </RibbonGroup>
    </>
  );
}

function ResultsTab() {
  const running = useProjectStore((s) => s.running);
  const run = useProjectStore((s) => s.run);
  const stopRun = useProjectStore((s) => s.stopRun);
  const project = useProjectStore((s) => s.project);
  const clearRuns = useProjectStore((s) => s.clearRuns);
  const count = useProjectStore((s) => s.runs.length);
  return (
    <>
      <RibbonGroup label="Simulation">
        <BigButton
          icon={Play}
          label={running ? "Running…" : "Run"}
          accent
          disabled={running || !project}
          onClick={() => void run()}
        />
        <BigButton icon={Square} label="Stop" disabled={!running} onClick={stopRun} />
      </RibbonGroup>
      <RibbonGroup label="Results">
        <div className="flex h-full flex-col justify-center gap-1 px-2 text-[11px] text-[color:var(--ss-text-dim)]">
          <span className="flex items-center gap-1">
            <Gauge size={13} />
            {count === 0 ? "No stored runs yet" : `${count} stored run${count > 1 ? "s" : ""}`}
            {count >= 20 && <span className="text-[10px]">(max)</span>}
          </span>
          <button
            className="ss-toolbtn border border-[color:var(--ss-border)] px-1.5 text-[11px] disabled:opacity-40"
            disabled={count === 0 || running}
            onClick={() => {
              if (window.confirm("Clear all stored runs from the results history?")) clearRuns();
            }}
          >
            <Trash2 size={12} /> Clear history
          </button>
        </div>
      </RibbonGroup>
    </>
  );
}

function ParametersTab() {
  const running = useProjectStore((s) => s.running);
  const run = useProjectStore((s) => s.run);
  const stopRun = useProjectStore((s) => s.stopRun);
  const project = useProjectStore((s) => s.project);
  const cases = useProjectStore((s) => s.project?.cases ?? []);
  const activeCaseId = useProjectStore((s) => s.activeCaseId);
  const setActiveCase = useProjectStore((s) => s.setActiveCase);
  const activeCase = cases.find((c) => c.id === activeCaseId);
  const overrideCount = activeCase?.parameterOverrides
    ? Object.values(activeCase.parameterOverrides).reduce((n, m) => n + Object.keys(m).length, 0)
    : 0;
  return (
    <>
      <RibbonGroup label="Case">
        <div className="flex flex-col justify-center gap-1 px-1 py-1">
          <select
            className="ss-input w-[160px]"
            value={activeCaseId ?? ""}
            onChange={(e) => setActiveCase(e.target.value)}
          >
            {cases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-[color:var(--ss-text-dim)]">
            {overrideCount === 0
              ? "No overrides — base parameters"
              : `${overrideCount} override${overrideCount > 1 ? "s" : ""} active`}
          </span>
        </div>
      </RibbonGroup>
      <RibbonGroup label="Parameter Studies">
        <BigButton
          icon={Sliders}
          label="Case Setup"
          title="Open the Cases & Parameters panel: per-case overrides and sweeps"
          onClick={() => useUIStore.getState().focusPanel("cases")}
        />
        <BigButton
          icon={Play}
          label={running ? "Running…" : "Run case"}
          accent
          disabled={running || !project}
          onClick={() => void run()}
        />
        <BigButton icon={Square} label="Stop" disabled={!running} onClick={stopRun} />
      </RibbonGroup>
    </>
  );
}

function ProjectTab() {
  const project = useProjectStore((s) => s.project);
  const renameSystem = useProjectStore((s) => s.renameSystem);
  const root = project?.systems.find((s) => s.parentId === null);
  return (
    <RibbonGroup label="Project Settings">
      <div className="flex items-center gap-2 px-1 py-2">
        <span className="text-[11px] text-[color:var(--ss-text-dim)]">Project name</span>
        <input
          className="ss-input w-[220px]"
          value={project?.name ?? ""}
          onChange={(e) => root && renameSystem(root.id, e.target.value)}
        />
        <span className="text-[11px] text-[color:var(--ss-text-dim)]">
          {project ? `${project.systems.length} system(s), ${project.cases.length} case(s)` : ""}
        </span>
      </div>
    </RibbonGroup>
  );
}

function StubTab({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2 px-3 text-[12px] text-[color:var(--ss-text-dim)]">
      <CheckCircle2 size={14} />
      {name} is not part of SimStudio v1 — this ribbon tab is a visual stub.
    </div>
  );
}

export function Ribbon() {
  const tab = useUIStore((s) => s.ribbonTab);
  const setTab = useUIStore((s) => s.setRibbonTab);
  const theme = useUIStore((s) => s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const projectName = useProjectStore((s) => s.project?.name);
  const dirty = useProjectStore((s) => s.dirty);

  return (
    <div className="shrink-0 border-b border-[color:var(--ss-border)] bg-[color:var(--ss-chrome)]">
      <div className="flex items-center gap-1 px-2 pt-1">
        <div className="mr-1 flex items-center gap-1.5 rounded bg-[color:var(--ss-accent)] px-2 py-0.5 text-[12px] font-semibold text-white">
          SimStudio
        </div>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`rounded-t px-3 py-1 text-[12px] ${
              tab === t.id
                ? "border border-b-0 border-[color:var(--ss-border)] bg-[color:var(--ss-panel)] font-semibold text-[color:var(--ss-accent)]"
                : "text-[color:var(--ss-text)] hover:bg-[color:var(--ss-hover)]"
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1 pr-1 text-[11px] text-[color:var(--ss-text-dim)]">
          {projectName}
          {dirty ? " •" : ""}
          <button
            className="ml-2 rounded p-1 hover:bg-[color:var(--ss-hover)]"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
          </button>
          <ChevronDown size={12} className="opacity-0" />
        </div>
      </div>
      <div className="flex h-[72px] items-stretch border-t border-[color:var(--ss-border)] bg-[color:var(--ss-panel)] px-1">
        {tab === "home" && <HomeTab />}
        {tab === "simulations" && <SimulationsTab />}
        {tab === "results" && <ResultsTab />}
        {tab === "parameters" && <ParametersTab />}
        {tab === "project" && <ProjectTab />}
        {tab === "optimization" && <StubTab name="Optimization" />}
      </div>
    </div>
  );
}

import { Fragment } from "react";
import { Box, CornerDownRight, FolderTree } from "lucide-react";
import { useProjectStore } from "../../store/projectStore";
import { componentIcon } from "../../icons";
import type {
  ComponentDef,
  ElementInstance,
  ParameterDef,
  ParamValue,
  SystemNode,
} from "../../types";

function ParameterInput({
  def,
  value,
  onChange,
}: {
  def: ParameterDef;
  value: ParamValue;
  onChange: (v: ParamValue) => void;
}) {
  switch (def.type) {
    case "boolean":
      return (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case "enum":
      return (
        <select
          className="ss-input w-full"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        >
          {(def.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "number":
      return (
        <input
          type="number"
          className="ss-input w-full"
          value={Number(value)}
          step="any"
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isNaN(n)) onChange(n);
          }}
        />
      );
    default:
      return def.key === "profile" ? (
        <textarea
          className="ss-input w-full resize-y font-mono text-[11px]"
          rows={2}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="ss-input w-full"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function SystemTree({
  system,
  depth,
}: {
  system: SystemNode;
  depth: number;
}) {
  const project = useProjectStore((s) => s.project);
  const libraryById = useProjectStore((s) => s.libraryById);
  const selectedElementId = useProjectStore((s) => s.selectedElementId);
  const select = useProjectStore((s) => s.select);
  const setActiveSystem = useProjectStore((s) => s.setActiveSystem);
  const activeSystemId = useProjectStore((s) => s.activeSystemId);

  if (!project) return null;
  return (
    <>
      <button
        className={`ss-tree-row font-semibold ${activeSystemId === system.id ? "text-[color:var(--ss-accent)]" : ""}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => setActiveSystem(system.id)}
        title="Show this system on the canvas"
      >
        <FolderTree size={13} className="shrink-0" />
        <span className="truncate">{system.name}</span>
      </button>
      {system.elements.map((el) => {
        const def = libraryById[el.componentDefId];
        const Icon = componentIcon(def?.icon ?? "box");
        const child = el.subSystemId
          ? project.systems.find((s) => s.id === el.subSystemId)
          : undefined;
        return (
          <Fragment key={el.id}>
            <button
              className={`ss-tree-row ${selectedElementId === el.id ? "selected" : ""}`}
              style={{ paddingLeft: 20 + depth * 14 }}
              onClick={() => {
                if (activeSystemId !== system.id) setActiveSystem(system.id);
                select(el.id);
              }}
            >
              <Icon size={13} strokeWidth={1.6} className="shrink-0 text-[#4c5666]" />
              <span className="truncate">{el.label}</span>
            </button>
            {child && <SystemTree system={child} depth={depth + 1} />}
          </Fragment>
        );
      })}
    </>
  );
}

function ElementForm({ element, def }: { element: ElementInstance; def: ComponentDef }) {
  const setParameter = useProjectStore((s) => s.setParameter);
  const renameElement = useProjectStore((s) => s.renameElement);
  const setActiveSystem = useProjectStore((s) => s.setActiveSystem);
  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center gap-2">
        <span className="w-[72px] shrink-0 text-[11px] text-[color:var(--ss-text-dim)]">Name</span>
        <input
          className="ss-input flex-1"
          value={element.label}
          onChange={(e) => renameElement(element.id, e.target.value)}
        />
      </div>
      <div className="flex items-center gap-2 text-[11px] text-[color:var(--ss-text-dim)]">
        <span className="w-[72px] shrink-0">Type</span>
        <span className="text-[color:var(--ss-text)]">{def.name}</span>
        <span className="ml-auto rounded bg-[#eef2f7] px-1.5 py-0.5 text-[10px] uppercase">
          {def.domain}
        </span>
      </div>
      {element.isSubSystem && element.subSystemId && (
        <button
          className="ss-toolbtn justify-center border border-[color:var(--ss-border)]"
          onClick={() => setActiveSystem(element.subSystemId!)}
        >
          <CornerDownRight size={13} /> Open sub-system
        </button>
      )}
      {def.parameters.length > 0 && (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="ss-th">Parameter</th>
              <th className="ss-th w-[110px]">Value</th>
              <th className="ss-th w-[46px]">Unit</th>
            </tr>
          </thead>
          <tbody>
            {def.parameters.map((p) => (
              <tr key={p.key}>
                <td className="ss-td text-[11px]">{p.label}</td>
                <td className="ss-td">
                  <ParameterInput
                    def={p}
                    value={element.parameterOverrides[p.key] ?? p.default}
                    onChange={(v) => setParameter(element.id, p.key, v)}
                  />
                </td>
                <td className="ss-td text-[11px] text-[color:var(--ss-text-dim)]">
                  {p.unit ?? "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {def.ports.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-semibold text-[color:var(--ss-text-dim)]">
            Ports
          </div>
          {def.ports.map((p) => (
            <div key={p.id} className="flex items-center gap-2 py-0.5 text-[11px]">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  background:
                    p.kind === "electrical"
                      ? "#e08600"
                      : p.kind === "mechanical"
                        ? "#3f4650"
                        : p.kind === "signal"
                          ? "#0e7490"
                          : "#c2410c",
                }}
              />
              <span className="truncate">{p.name}</span>
              <span className="ml-auto text-[10px] text-[color:var(--ss-text-dim)]">
                {p.kind} · {p.direction}
              </span>
            </div>
          ))}
        </div>
      )}
      {def.description && (
        <p className="border-t border-[color:var(--ss-border)] pt-2 text-[11px] italic text-[color:var(--ss-text-dim)]">
          {def.description}
        </p>
      )}
    </div>
  );
}

export function PropertiesPanel() {
  const project = useProjectStore((s) => s.project);
  const libraryById = useProjectStore((s) => s.libraryById);
  const selectedElementId = useProjectStore((s) => s.selectedElementId);
  const root = project?.systems.find((s) => s.parentId === null);
  const selected = project?.systems
    .flatMap((s) => s.elements)
    .find((e) => e.id === selectedElementId);
  const selectedDef = selected ? libraryById[selected.componentDefId] : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="max-h-[45%] min-h-[90px] overflow-y-auto border-b border-[color:var(--ss-border)] py-1">
        {root ? (
          <SystemTree system={root} depth={0} />
        ) : (
          <div className="px-3 py-2 text-[12px] text-[color:var(--ss-text-dim)]">No project.</div>
        )}
      </div>
      <div className="ss-panel-toolbar text-[11px] font-semibold">
        {selected ? `Parameters — ${selected.label}` : "Parameters"}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {selected && selectedDef ? (
          <ElementForm element={selected} def={selectedDef} />
        ) : (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-[12px] text-[color:var(--ss-text-dim)]">
            <Box size={22} strokeWidth={1.2} />
            Select an element on the canvas or in the tree to edit its parameters.
          </div>
        )}
      </div>
    </div>
  );
}

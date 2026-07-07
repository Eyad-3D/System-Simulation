import { Fragment, useMemo, useState } from "react";
import { Box, CornerDownRight, FolderTree, Plus, Radio, Trash2 } from "lucide-react";
import { useProjectStore } from "../../store/projectStore";
import { componentIcon } from "../../icons";
import type {
  AxisDef,
  ComponentDef,
  ElementInstance,
  ParameterDef,
  ParamValue,
  PortDef,
  SystemNode,
  Table1D,
  Table2D,
} from "../../types";

function sortedNumericKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort((a, b) => Number(a) - Number(b));
}

/** Editable grid for a 1D lookup table {x: y}. */
function Table1DEditor({
  value,
  axis,
  valueLabel,
  valueUnit,
  onChange,
}: {
  value: Table1D;
  axis: AxisDef;
  valueLabel: string;
  valueUnit: string;
  onChange: (v: Table1D) => void;
}) {
  const keys = sortedNumericKeys(value);
  const commitX = (oldKey: string, next: string) => {
    const n = Number(next);
    if (!Number.isFinite(n) || String(n) === oldKey) return;
    const copy: Table1D = { ...value };
    const y = copy[oldKey];
    delete copy[oldKey];
    copy[String(n)] = y;
    onChange(copy);
  };
  const commitY = (key: string, next: string) => {
    const n = Number(next);
    if (!Number.isFinite(n)) return;
    onChange({ ...value, [key]: n });
  };
  const addRow = () => {
    const last = keys.length ? Number(keys[keys.length - 1]) : 0;
    const prev = keys.length > 1 ? Number(keys[keys.length - 2]) : last - 1;
    const step = keys.length > 1 ? last - prev : 500;
    const newX = last + (step || 500);
    onChange({ ...value, [String(newX)]: keys.length ? value[keys[keys.length - 1]] : 0 });
  };
  const removeRow = (key: string) => {
    if (keys.length <= 1) return;
    const copy = { ...value };
    delete copy[key];
    onChange(copy);
  };
  return (
    <div className="rounded border border-[color:var(--ss-border)]">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="ss-th">{axis.name} ({axis.unit})</th>
            <th className="ss-th">{valueLabel} ({valueUnit})</th>
            <th className="ss-th w-[26px]" />
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k}>
              <td className="ss-td">
                <input
                  type="number"
                  step="any"
                  className="ss-input w-full"
                  defaultValue={k}
                  onBlur={(e) => commitX(k, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
              </td>
              <td className="ss-td">
                <input
                  type="number"
                  step="any"
                  className="ss-input w-full"
                  value={value[k]}
                  onChange={(e) => commitY(k, e.target.value)}
                />
              </td>
              <td className="ss-td text-center">
                <button
                  className="text-[color:var(--ss-text-dim)] hover:text-red-600 disabled:opacity-30"
                  title="Remove row"
                  disabled={keys.length <= 1}
                  onClick={() => removeRow(k)}
                >
                  <Trash2 size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="flex w-full items-center justify-center gap-1 py-1 text-[11px] text-[color:var(--ss-accent)] hover:bg-[color:var(--ss-accent-soft)]"
        onClick={addRow}
      >
        <Plus size={12} /> Add row
      </button>
    </div>
  );
}

/** Editable 2D map {outer: {inner: y}} — sheet selector over the outer axis. */
function Table2DEditor({
  value,
  axes,
  valueLabel,
  valueUnit,
  onChange,
}: {
  value: Table2D;
  axes: [AxisDef, AxisDef];
  valueLabel: string;
  valueUnit: string;
  onChange: (v: Table2D) => void;
}) {
  const sheetKeys = sortedNumericKeys(value);
  const [selected, setSelected] = useState<string>(sheetKeys[0] ?? "");
  const [newSheet, setNewSheet] = useState("");
  const current = value[selected] ? selected : (sheetKeys[0] ?? "");
  const addSheet = () => {
    const n = Number(newSheet);
    if (!Number.isFinite(n) || value[String(n)]) return;
    const template = current ? { ...value[current] } : { "0": 0 };
    onChange({ ...value, [String(n)]: template });
    setSelected(String(n));
    setNewSheet("");
  };
  const removeSheet = () => {
    if (sheetKeys.length <= 1 || !current) return;
    const copy = { ...value };
    delete copy[current];
    onChange(copy);
    setSelected(sortedNumericKeys(copy)[0]);
  };
  if (!current) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 text-[11px]">
        <span className="text-[color:var(--ss-text-dim)]">{axes[0].name} ({axes[0].unit})</span>
        <select
          className="ss-input w-[76px]"
          value={current}
          onChange={(e) => setSelected(e.target.value)}
        >
          {sheetKeys.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <input
          type="number"
          step="any"
          className="ss-input w-[64px]"
          placeholder="new…"
          value={newSheet}
          onChange={(e) => setNewSheet(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addSheet()}
        />
        <button className="ss-toolbtn" title={`Add ${axes[0].name} sheet`} onClick={addSheet}>
          <Plus size={12} />
        </button>
        <button
          className="ss-toolbtn disabled:opacity-30"
          title="Remove this sheet"
          disabled={sheetKeys.length <= 1}
          onClick={removeSheet}
        >
          <Trash2 size={12} />
        </button>
      </div>
      <Table1DEditor
        value={value[current]}
        axis={axes[1]}
        valueLabel={valueLabel}
        valueUnit={valueUnit}
        onChange={(inner) => onChange({ ...value, [current]: inner })}
      />
    </div>
  );
}

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
    case "code":
      return (
        <textarea
          className="ss-input w-full resize-y font-mono text-[11px]"
          rows={12}
          spellCheck={false}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
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

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "port";
}

/** Add/rename/remove per-instance signal ports (Script, Monitor). */
function DynamicPortsEditor({ element }: { element: ElementInstance }) {
  const setDynamicPorts = useProjectStore((s) => s.setDynamicPorts);
  const ports = element.dynamicPorts ?? [];
  const commit = (next: PortDef[]) => setDynamicPorts(element.id, next);
  const add = (direction: "input" | "output") => {
    const base = direction === "input" ? "in" : "out";
    let n = 1;
    while (ports.some((p) => p.id === `${base}_${n}`)) n += 1;
    commit([
      ...ports,
      {
        id: `${base}_${n}`,
        name: `${base}_${n}`,
        direction,
        kind: "signal",
        unitGroup: "No Unit",
      },
    ]);
  };
  const rename = (port: PortDef, name: string) => {
    let id = slugify(name);
    while (ports.some((p) => p.id === id && p.id !== port.id)) id += "_";
    commit(ports.map((p) => (p.id === port.id ? { ...p, id, name: id } : p)));
  };
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-[color:var(--ss-text-dim)]">
        Signal Ports
        <button
          className="ss-toolbtn border border-[color:var(--ss-border)] px-1.5 text-[10px] font-normal"
          onClick={() => add("input")}
        >
          <Plus size={10} /> input
        </button>
        <button
          className="ss-toolbtn border border-[color:var(--ss-border)] px-1.5 text-[10px] font-normal"
          onClick={() => add("output")}
        >
          <Plus size={10} /> output
        </button>
      </div>
      {ports.length === 0 && (
        <div className="px-1 pb-1 text-[11px] italic text-[color:var(--ss-text-dim)]">
          No ports yet — add inputs/outputs; their names are the keys in the
          script's <code>inputs</code> / returned dict.
        </div>
      )}
      {ports.map((p) => (
        <div key={p.id} className="flex items-center gap-1 py-0.5">
          <span
            className={`rounded px-1 text-[9px] font-semibold uppercase ${
              p.direction === "input" ? "bg-[#e0f2f7] text-[#0e7490]" : "bg-[#fdf1e2] text-[#b45309]"
            }`}
          >
            {p.direction === "input" ? "in" : "out"}
          </span>
          <input
            className="ss-input flex-1 font-mono text-[11px]"
            defaultValue={p.name}
            title="Port name (renaming disconnects existing wires)"
            onBlur={(e) => e.target.value !== p.name && rename(p, e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <button
            className="text-[color:var(--ss-text-dim)] hover:text-red-600"
            title="Remove port (disconnects its wires)"
            onClick={() => commit(ports.filter((q) => q.id !== p.id))}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  );
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
              <Icon size={13} strokeWidth={1.6} className="shrink-0 text-[color:var(--ss-node-icon)]" />
              <span className="truncate">{el.label}</span>
            </button>
            {child && <SystemTree system={child} depth={depth + 1} />}
          </Fragment>
        );
      })}
    </>
  );
}

export function ElementForm({ element, def }: { element: ElementInstance; def: ComponentDef }) {
  const setParameter = useProjectStore((s) => s.setParameter);
  const renameElement = useProjectStore((s) => s.renameElement);
  const setActiveSystem = useProjectStore((s) => s.setActiveSystem);
  const running = useProjectStore((s) => s.running);

  const scalarParams = useMemo(
    () => def.parameters.filter((p) => p.type !== "table1d" && p.type !== "table2d" && p.type !== "code"),
    [def],
  );
  const bigParams = useMemo(
    () => def.parameters.filter((p) => p.type === "table1d" || p.type === "table2d" || p.type === "code"),
    [def],
  );
  const valueOf = (p: ParameterDef): ParamValue =>
    element.parameterOverrides[p.key] ?? p.default;

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
        {running && (
          <span
            className="flex items-center gap-1 rounded bg-[#e5f5eb] px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700"
            title="Simulation running — number/switch edits apply immediately; tables and code apply on the next run"
          >
            <Radio size={10} /> LIVE
          </span>
        )}
        <span className="ml-auto rounded bg-[color:var(--ss-panel-alt)] px-1.5 py-0.5 text-[10px] uppercase">
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
      {scalarParams.length > 0 && (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="ss-th">Parameter</th>
              <th className="ss-th w-[110px]">Value</th>
              <th className="ss-th w-[52px]">Unit</th>
            </tr>
          </thead>
          <tbody>
            {scalarParams.map((p) => (
              <tr key={p.key}>
                <td className="ss-td text-[11px]">{p.label}</td>
                <td className="ss-td">
                  <ParameterInput
                    def={p}
                    value={valueOf(p)}
                    onChange={(v) => setParameter(element.id, p.key, v)}
                  />
                </td>
                <td className="ss-td text-[11px] text-[color:var(--ss-text-dim)]">{p.unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {bigParams.map((p) => (
        <div key={p.key}>
          <div className="mb-1 text-[11px] font-semibold text-[color:var(--ss-text-dim)]">
            {p.label} {p.type !== "code" ? `(${p.unit})` : ""}
            {running && (
              <span className="ml-1 font-normal italic">— applies on next run</span>
            )}
          </div>
          {p.type === "table1d" && p.axes?.length === 1 ? (
            <Table1DEditor
              value={valueOf(p) as Table1D}
              axis={p.axes[0]}
              valueLabel={p.label}
              valueUnit={p.unit}
              onChange={(v) => setParameter(element.id, p.key, v)}
            />
          ) : p.type === "table2d" && p.axes?.length === 2 ? (
            <Table2DEditor
              value={valueOf(p) as Table2D}
              axes={[p.axes[0], p.axes[1]]}
              valueLabel={p.label}
              valueUnit={p.unit}
              onChange={(v) => setParameter(element.id, p.key, v)}
            />
          ) : (
            <ParameterInput
              def={p}
              value={valueOf(p)}
              onChange={(v) => setParameter(element.id, p.key, v)}
            />
          )}
        </div>
      ))}
      {def.allowDynamicPorts && <DynamicPortsEditor element={element} />}
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

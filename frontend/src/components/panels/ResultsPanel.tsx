import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Download,
  Image as ImageIcon,
  LineChart as LineChartIcon,
  Play,
  Search,
  Table2,
  X,
} from "lucide-react";
import { useActiveRun, useCompareRun, useProjectStore } from "../../store/projectStore";
import { useUIStore } from "../../store/uiStore";
import type { Channel, SimResult, SimRun } from "../../types";

const PALETTE = [
  "#2f6fb3",
  "#d97706",
  "#059669",
  "#dc2626",
  "#7c3aed",
  "#0e7490",
  "#be185d",
  "#4d7c0f",
  "#b45309",
  "#1d4ed8",
];

const MAX_PLOT_POINTS = 2000;

function channelKey(c: Channel): string {
  return `${c.elementId}:${c.portId}`;
}

function runLabel(r: SimRun): string {
  const time = new Date(r.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${r.caseName} · ${time} · ${r.status}`;
}

/** Stride-decimate a series so charts/tables stay responsive (keeps the endpoints). */
function decimate<T>(arr: T[], max = MAX_PLOT_POINTS): T[] {
  if (arr.length <= max) return arr;
  const stride = Math.ceil(arr.length / max);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

/** True once the element has a real size — dockview keeps hidden tabs at 0×0,
 *  and recharts warns loudly if asked to render there. */
function useHasSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [hasSize, setHasSize] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const obs = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      setHasSize(!!r && r.width > 0 && r.height > 0);
    });
    obs.observe(node);
    return () => obs.disconnect();
  }, []);
  return { ref, hasSize };
}

function exportCsv(result: SimResult, keys: Set<string>, name: string) {
  const channels = result.channels.filter((c) => keys.has(channelKey(c)));
  if (channels.length === 0) return;
  const header = ["t_s", ...channels.map((c) => `${c.label} [${c.unit}]`)];
  const rows = channels[0].timeSeries.map((pt, i) => [
    pt.t,
    ...channels.map((c) => c.timeSeries[i]?.value ?? ""),
  ]);
  const csv = [header, ...rows].map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Rasterize the chart's SVG to a PNG download (2× for crispness). */
function exportPng(host: HTMLElement | null, bg: string, name: string) {
  const svg = host?.querySelector("svg");
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true) as SVGElement;
  clone.setAttribute("width", String(rect.width));
  clone.setAttribute("height", String(rect.height));
  const xml = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = rect.width * scale;
    canvas.height = rect.height * scale;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
    }
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
  };
  img.src = url;
}

export function ResultsPanel() {
  const runs = useProjectStore((s) => s.runs);
  const activeRun = useActiveRun();
  const compareRun = useCompareRun();
  const setActiveRun = useProjectStore((s) => s.setActiveRun);
  const setCompareRun = useProjectStore((s) => s.setCompareRun);
  const removeRun = useProjectStore((s) => s.removeRun);
  const running = useProjectStore((s) => s.running);
  const run = useProjectStore((s) => s.run);
  const theme = useUIStore((s) => s.theme);

  const result = activeRun?.result;
  const compareResult = compareRun?.result;
  const selKey = activeRun?.caseId ?? "";

  // channel selection is keyed by case, so comparing two runs of the same
  // case keeps the same channels ticked
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [view, setView] = useState<"chart" | "table">("chart");
  const [search, setSearch] = useState("");
  const { ref: chartHost, hasSize } = useHasSize<HTMLDivElement>();

  // sensible default channel selection the first time a case's results are shown
  useEffect(() => {
    if (!result || !selKey || selected[selKey]) return;
    const defaults = result.channels
      .filter((c) => c.portId === "sig_soc" || (c.portId === "sig_power" && c.label.includes("Battery")))
      .slice(0, 4)
      .map(channelKey);
    setSelected((s) => ({
      ...s,
      [selKey]: defaults.length > 0 ? defaults : result.channels.slice(0, 2).map(channelKey),
    }));
  }, [result, selKey, selected]);

  const selectedKeys = useMemo(
    () => new Set(selKey ? (selected[selKey] ?? []) : []),
    [selected, selKey],
  );

  const byElement = useMemo(() => {
    const q = search.trim().toLowerCase();
    const groups = new Map<string, Channel[]>();
    for (const c of result?.channels ?? []) {
      if (q && !c.label.toLowerCase().includes(q) && !c.unit.toLowerCase().includes(q)) continue;
      const el = c.label.split(" · ")[0];
      if (!groups.has(el)) groups.set(el, []);
      groups.get(el)!.push(c);
    }
    return [...groups.entries()];
  }, [result, search]);

  const activeChannels = useMemo(
    () => result?.channels.filter((c) => selectedKeys.has(channelKey(c))) ?? [],
    [result, selectedKeys],
  );
  const compareChannels = useMemo(
    () => compareResult?.channels.filter((c) => selectedKeys.has(channelKey(c))) ?? [],
    [compareResult, selectedKeys],
  );

  // distinct units → one Y axis each (dimensionally-correct multi-axis plot)
  const units = useMemo(
    () => [...new Set(activeChannels.map((c) => c.unit))],
    [activeChannels],
  );
  const colorOf = (key: string) => {
    const idx = [...selectedKeys].indexOf(key);
    return PALETTE[(idx < 0 ? 0 : idx) % PALETTE.length];
  };

  const chartData = useMemo(() => {
    const map = new Map<number, Record<string, number>>();
    const put = (t: number, k: string, v: number) => {
      let r = map.get(t);
      if (!r) {
        r = { t };
        map.set(t, r);
      }
      r[k] = v;
    };
    for (const c of activeChannels) for (const pt of decimate(c.timeSeries)) put(pt.t, channelKey(c), pt.value);
    for (const c of compareChannels) for (const pt of decimate(c.timeSeries)) put(pt.t, `cmp:${channelKey(c)}`, pt.value);
    return [...map.values()].sort((a, b) => a.t - b.t);
  }, [activeChannels, compareChannels]);

  // table shows only the active run (aligned time grid)
  const tableData = useMemo(() => {
    if (activeChannels.length === 0) return [];
    const cols = activeChannels.map((c) => decimate(c.timeSeries));
    return cols[0].map((pt, i) => {
      const row: Record<string, number> = { t: pt.t };
      activeChannels.forEach((c, ci) => {
        const p = cols[ci][i];
        if (p) row[channelKey(c)] = p.value;
      });
      return row;
    });
  }, [activeChannels]);

  const toggle = (key: string) => {
    if (!selKey) return;
    setSelected((s) => {
      const cur = s[selKey] ?? [];
      return {
        ...s,
        [selKey]: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key],
      };
    });
  };

  if (runs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-[color:var(--ss-text-dim)]">
        <LineChartIcon size={36} strokeWidth={1} />
        <div className="text-[13px]">No results yet — run a simulation case first.</div>
        <button
          className="ss-toolbtn border border-[color:var(--ss-border)] px-3"
          disabled={running}
          onClick={() => void run()}
        >
          <Play size={13} className="text-[color:var(--ss-accent)]" />
          {running ? "Running…" : "Run active case"}
        </button>
      </div>
    );
  }

  const channelLabel = (key: string): { label: string; unit: string } => {
    const c = result?.channels.find((ch) => channelKey(ch) === key);
    return { label: c?.label ?? key, unit: c?.unit ?? "" };
  };

  return (
    <div className="flex h-full">
      {/* channel picker */}
      <div className="flex w-[270px] shrink-0 flex-col border-r border-[color:var(--ss-border)]">
        <div className="flex flex-col gap-1 border-b border-[color:var(--ss-border)] bg-[color:var(--ss-panel-alt)] p-1.5">
          <div className="flex items-center gap-1">
            <select
              className="ss-input min-w-0 flex-1"
              value={activeRun?.id ?? ""}
              onChange={(e) => setActiveRun(e.target.value)}
              title="Run shown in the chart"
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {runLabel(r)}
                </option>
              ))}
            </select>
            <button
              className="ss-toolbtn"
              title="Remove this run from history"
              disabled={!activeRun || running}
              onClick={() => activeRun && removeRun(activeRun.id)}
            >
              <X size={13} />
            </button>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-[color:var(--ss-text-dim)]">Compare</span>
            <select
              className="ss-input min-w-0 flex-1"
              value={compareRun?.id ?? ""}
              onChange={(e) => setCompareRun(e.target.value || null)}
              title="Overlay a second run (dashed)"
            >
              <option value="">none</option>
              {runs
                .filter((r) => r.id !== activeRun?.id)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {runLabel(r)}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex items-center gap-1 rounded border border-[color:var(--ss-border)] bg-[color:var(--ss-panel)] px-1.5">
            <Search size={12} className="shrink-0 text-[color:var(--ss-text-dim)]" />
            <input
              className="w-full bg-transparent py-1 text-[12px] outline-none"
              placeholder="Search channels…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button className="text-[color:var(--ss-text-dim)] hover:text-[color:var(--ss-text)]" onClick={() => setSearch("")}>
                <X size={12} />
              </button>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {byElement.length === 0 && (
            <div className="px-3 py-2 text-[11px] italic text-[color:var(--ss-text-dim)]">
              No channels match “{search}”.
            </div>
          )}
          {byElement.map(([element, channels]) => (
            <div key={element}>
              <div className="px-2 py-1 text-[11px] font-semibold text-[color:var(--ss-text-dim)]">
                {element}
              </div>
              {channels.map((c) => {
                const key = channelKey(c);
                return (
                  <label
                    key={key}
                    className="ss-tree-row cursor-pointer pl-4"
                    title={`${c.label} [${c.unit}]`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedKeys.has(key)}
                      onChange={() => toggle(key)}
                    />
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: selectedKeys.has(key) ? colorOf(key) : "#d0d5dd" }}
                    />
                    <span className="truncate">{c.label.split(" · ")[1] ?? c.label}</span>
                    <span className="ml-auto pr-1 text-[10px] text-[color:var(--ss-text-dim)]">
                      {c.unit}
                    </span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {/* chart + summary */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="ss-panel-toolbar">
          <span className="text-[11px] text-[color:var(--ss-text-dim)]">
            {activeChannels.length} channel(s)
            {compareRun && <span> · vs <b>{compareRun.caseName}</b> (dashed)</span>}
            {result && (
              <>
                {" · "}
                <b
                  className={
                    running && activeRun?.status === "running"
                      ? "text-[color:var(--ss-accent)]"
                      : result.status === "success"
                        ? "text-emerald-700"
                        : result.status === "warning"
                          ? "text-amber-600"
                          : "text-red-600"
                  }
                >
                  {activeRun?.status === "running" ? "running…" : result.status}
                </b>
              </>
            )}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <div className="flex overflow-hidden rounded border border-[color:var(--ss-border)]">
              <button
                className={`flex items-center gap-1 px-2 py-1 text-[11px] ${
                  view === "chart" ? "bg-[color:var(--ss-active)] font-semibold" : "hover:bg-[color:var(--ss-hover)]"
                }`}
                onClick={() => setView("chart")}
                title="Chart view"
              >
                <LineChartIcon size={12} /> Chart
              </button>
              <button
                className={`flex items-center gap-1 border-l border-[color:var(--ss-border)] px-2 py-1 text-[11px] ${
                  view === "table" ? "bg-[color:var(--ss-active)] font-semibold" : "hover:bg-[color:var(--ss-hover)]"
                }`}
                onClick={() => setView("table")}
                title="Table view"
              >
                <Table2 size={12} /> Table
              </button>
            </div>
            <button
              className="ss-toolbtn border border-[color:var(--ss-border)]"
              disabled={view !== "chart" || activeChannels.length === 0}
              title="Export the chart as a PNG image"
              onClick={() =>
                exportPng(
                  chartHost.current,
                  theme === "dark" ? "#1b1f26" : "#ffffff",
                  `simstudio-${activeRun?.caseName ?? "chart"}`,
                )
              }
            >
              <ImageIcon size={12} /> PNG
            </button>
            <button
              className="ss-toolbtn border border-[color:var(--ss-border)]"
              disabled={!result || activeChannels.length === 0}
              onClick={() => result && exportCsv(result, selectedKeys, `simstudio-${activeRun?.caseName ?? "results"}`)}
            >
              <Download size={12} /> CSV
            </button>
          </div>
        </div>
        {view === "table" ? (
          <div className="min-h-0 flex-[3] overflow-auto">
            {activeChannels.length > 0 && tableData.length > 0 ? (
              <table className="w-full border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr>
                    <th className="ss-th w-[70px] text-right">t [s]</th>
                    {activeChannels.map((c) => (
                      <th key={channelKey(c)} className="ss-th text-right" title={c.label}>
                        {c.label.split(" · ")[1] ?? c.label} [{c.unit}]
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableData.map((row, i) => (
                    <tr key={i} className="hover:bg-[color:var(--ss-hover)]">
                      <td className="ss-td text-right font-mono text-[color:var(--ss-text-dim)]">
                        {typeof row.t === "number" ? row.t.toLocaleString() : row.t}
                      </td>
                      {activeChannels.map((c) => {
                        const v = row[channelKey(c)];
                        return (
                          <td key={channelKey(c)} className="ss-td text-right font-mono">
                            {typeof v === "number"
                              ? v.toLocaleString(undefined, { maximumFractionDigits: 4 })
                              : "—"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--ss-text-dim)]">
                Tick channels on the left to tabulate them.
              </div>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-[3] p-1" ref={chartHost}>
            {chartData.length > 0 && hasSize ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                  <CartesianGrid stroke={theme === "dark" ? "#2a2f37" : "#eceff3"} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tick={{ fontSize: 10 }}
                    label={{ value: "t [s]", position: "insideBottomRight", fontSize: 10, offset: -2 }}
                  />
                  {units.map((u, i) => (
                    <YAxis
                      key={u}
                      yAxisId={u}
                      orientation={i % 2 === 0 ? "left" : "right"}
                      tick={{ fontSize: 10 }}
                      width={46}
                      label={{
                        value: u,
                        angle: -90,
                        position: i % 2 === 0 ? "insideLeft" : "insideRight",
                        fontSize: 10,
                        style: { textAnchor: "middle" },
                      }}
                    />
                  ))}
                  <Tooltip
                    contentStyle={{
                      fontSize: 11,
                      background: "var(--ss-panel)",
                      border: "1px solid var(--ss-border)",
                      color: "var(--ss-text)",
                    }}
                    labelFormatter={(t) => `t = ${t} s`}
                    formatter={(value, name) => {
                      const raw = String(name);
                      const isCmp = raw.startsWith("cmp:");
                      const { label, unit } = channelLabel(isCmp ? raw.slice(4) : raw);
                      const v =
                        typeof value === "number"
                          ? value.toLocaleString(undefined, { maximumFractionDigits: 3 })
                          : String(value ?? "");
                      return [`${v} ${unit}`, `${isCmp ? "↔ " : ""}${label}`];
                    }}
                  />
                  <Legend
                    formatter={(key: string) => {
                      const isCmp = key.startsWith("cmp:");
                      const { label, unit } = channelLabel(isCmp ? key.slice(4) : key);
                      return (
                        <span style={{ fontSize: 10 }}>
                          {isCmp ? "↔ " : ""}
                          {label} [{unit}]
                        </span>
                      );
                    }}
                  />
                  {activeChannels.map((c) => {
                    const key = channelKey(c);
                    return (
                      <Line
                        key={key}
                        yAxisId={c.unit}
                        dataKey={key}
                        type="linear"
                        dot={false}
                        strokeWidth={1.6}
                        stroke={colorOf(key)}
                        connectNulls
                        isAnimationActive={false}
                      />
                    );
                  })}
                  {compareChannels.map((c) => {
                    const key = channelKey(c);
                    return (
                      <Line
                        key={`cmp:${key}`}
                        yAxisId={c.unit}
                        dataKey={`cmp:${key}`}
                        type="linear"
                        dot={false}
                        strokeWidth={1.4}
                        strokeDasharray="4 3"
                        stroke={colorOf(key)}
                        connectNulls
                        isAnimationActive={false}
                      />
                    );
                  })}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--ss-text-dim)]">
                Tick channels on the left to plot them.
              </div>
            )}
          </div>
        )}
        {result && result.summary.length > 0 && (
          <div className="max-h-[130px] shrink-0 overflow-y-auto border-t border-[color:var(--ss-border)]">
            <table className="w-full border-collapse">
              <thead className="sticky top-0">
                <tr>
                  <th className="ss-th">Summary value</th>
                  <th className="ss-th w-[110px] text-right">Value</th>
                  {compareResult && <th className="ss-th w-[110px] text-right">Compare</th>}
                  <th className="ss-th w-[64px]">Unit</th>
                </tr>
              </thead>
              <tbody>
                {result.summary.map((s, i) => {
                  const cmp = compareResult?.summary.find((cs) => cs.label === s.label);
                  return (
                    <tr key={i} className="hover:bg-[color:var(--ss-hover)]">
                      <td className="ss-td">{s.label}</td>
                      <td className="ss-td text-right font-mono">{s.value.toLocaleString()}</td>
                      {compareResult && (
                        <td className="ss-td text-right font-mono text-[color:var(--ss-text-dim)]">
                          {cmp ? cmp.value.toLocaleString() : "—"}
                        </td>
                      )}
                      <td className="ss-td text-[color:var(--ss-text-dim)]">{s.unit}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
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
import { Download, LineChart as LineChartIcon, Play } from "lucide-react";
import { useProjectStore } from "../../store/projectStore";
import type { Channel, SimResult } from "../../types";

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

function channelKey(c: Channel): string {
  return `${c.elementId}:${c.portId}`;
}

function exportCsv(result: SimResult, keys: Set<string>) {
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
  a.download = `simstudio-results-${result.caseId}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ResultsPanel() {
  const results = useProjectStore((s) => s.results);
  const project = useProjectStore((s) => s.project);
  const activeResultCaseId = useProjectStore((s) => s.activeResultCaseId);
  const setActiveResultCase = useProjectStore((s) => s.setActiveResultCase);
  const running = useProjectStore((s) => s.running);
  const run = useProjectStore((s) => s.run);

  const result = activeResultCaseId ? results[activeResultCaseId] : undefined;
  const [selected, setSelected] = useState<Record<string, string[]>>({});

  // sensible default channel selection the first time a result is shown
  useEffect(() => {
    if (!result || !activeResultCaseId || selected[activeResultCaseId]) return;
    const defaults = result.channels
      .filter((c) => c.portId === "sig_soc" || (c.portId === "sig_power" && c.label.includes("Battery")))
      .slice(0, 4)
      .map(channelKey);
    setSelected((s) => ({
      ...s,
      [activeResultCaseId]: defaults.length > 0 ? defaults : result.channels.slice(0, 2).map(channelKey),
    }));
  }, [result, activeResultCaseId, selected]);

  const selectedKeys = useMemo(
    () => new Set(activeResultCaseId ? (selected[activeResultCaseId] ?? []) : []),
    [selected, activeResultCaseId],
  );

  const byElement = useMemo(() => {
    const groups = new Map<string, Channel[]>();
    for (const c of result?.channels ?? []) {
      const el = c.label.split(" · ")[0];
      if (!groups.has(el)) groups.set(el, []);
      groups.get(el)!.push(c);
    }
    return [...groups.entries()];
  }, [result]);

  const chartData = useMemo(() => {
    if (!result) return [];
    const chans = result.channels.filter((c) => selectedKeys.has(channelKey(c)));
    if (chans.length === 0) return [];
    const n = Math.max(...chans.map((c) => c.timeSeries.length));
    const rows: Record<string, number>[] = [];
    for (let i = 0; i < n; i++) {
      const row: Record<string, number> = { t: chans[0].timeSeries[i]?.t ?? i };
      for (const c of chans) {
        const pt = c.timeSeries[i];
        if (pt) row[channelKey(c)] = pt.value;
      }
      rows.push(row);
    }
    return rows;
  }, [result, selectedKeys]);

  const toggle = (key: string) => {
    if (!activeResultCaseId) return;
    setSelected((s) => {
      const cur = s[activeResultCaseId] ?? [];
      return {
        ...s,
        [activeResultCaseId]: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key],
      };
    });
  };

  if (Object.keys(results).length === 0) {
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

  const caseName = (caseId: string) =>
    project?.cases.find((c) => c.id === caseId)?.name ?? caseId;

  const selectedChannels = result?.channels.filter((c) => selectedKeys.has(channelKey(c))) ?? [];

  return (
    <div className="flex h-full">
      {/* channel picker */}
      <div className="flex w-[270px] shrink-0 flex-col border-r border-[color:var(--ss-border)]">
        <div className="ss-panel-toolbar">
          <select
            className="ss-input flex-1"
            value={activeResultCaseId ?? ""}
            onChange={(e) => setActiveResultCase(e.target.value)}
          >
            {Object.entries(results).map(([caseId, r]) => (
              <option key={caseId} value={caseId}>
                {caseName(caseId)} — {r.status}
              </option>
            ))}
          </select>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {byElement.map(([element, channels]) => (
            <div key={element}>
              <div className="px-2 py-1 text-[11px] font-semibold text-[color:var(--ss-text-dim)]">
                {element}
              </div>
              {channels.map((c) => {
                const key = channelKey(c);
                const idx = [...selectedKeys].indexOf(key);
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
                      style={{
                        background: idx >= 0 ? PALETTE[idx % PALETTE.length] : "#d0d5dd",
                      }}
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
            {selectedChannels.length} channel(s) plotted
            {result && (
              <>
                {" · status "}
                <b
                  className={
                    result.status === "success"
                      ? "text-emerald-700"
                      : result.status === "warning"
                        ? "text-amber-600"
                        : "text-red-600"
                  }
                >
                  {result.status}
                </b>
              </>
            )}
          </span>
          <button
            className="ss-toolbtn ml-auto border border-[color:var(--ss-border)]"
            disabled={!result || selectedChannels.length === 0}
            onClick={() => result && exportCsv(result, selectedKeys)}
          >
            <Download size={12} /> CSV
          </button>
        </div>
        <div className="min-h-0 flex-[3] p-1">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 20, bottom: 4, left: 4 }}>
                <CartesianGrid stroke="#eceff3" />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tick={{ fontSize: 10 }}
                  label={{ value: "t [s]", position: "insideBottomRight", fontSize: 10, offset: -2 }}
                />
                <YAxis tick={{ fontSize: 10 }} width={52} />
                <Tooltip
                  contentStyle={{ fontSize: 11 }}
                  labelFormatter={(t) => `t = ${t} s`}
                  formatter={(value, name) => {
                    const c = result?.channels.find((ch) => channelKey(ch) === String(name));
                    const v =
                      typeof value === "number"
                        ? value.toLocaleString(undefined, { maximumFractionDigits: 3 })
                        : String(value ?? "");
                    return [`${v} ${c?.unit ?? ""}`, c?.label ?? String(name)];
                  }}
                />
                <Legend
                  formatter={(key: string) => {
                    const c = result?.channels.find((ch) => channelKey(ch) === key);
                    return (
                      <span style={{ fontSize: 10 }}>
                        {c ? `${c.label} [${c.unit}]` : key}
                      </span>
                    );
                  }}
                />
                {selectedChannels.map((c) => {
                  const key = channelKey(c);
                  const idx = [...selectedKeys].indexOf(key);
                  return (
                    <Line
                      key={key}
                      dataKey={key}
                      type="linear"
                      dot={false}
                      strokeWidth={1.6}
                      stroke={PALETTE[idx % PALETTE.length]}
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
        {result && result.summary.length > 0 && (
          <div className="max-h-[130px] shrink-0 overflow-y-auto border-t border-[color:var(--ss-border)]">
            <table className="w-full border-collapse">
              <thead className="sticky top-0">
                <tr>
                  <th className="ss-th">Summary value</th>
                  <th className="ss-th w-[110px] text-right">Value</th>
                  <th className="ss-th w-[64px]">Unit</th>
                </tr>
              </thead>
              <tbody>
                {result.summary.map((s, i) => (
                  <tr key={i} className="hover:bg-[#eef2f7]">
                    <td className="ss-td">{s.label}</td>
                    <td className="ss-td text-right font-mono">{s.value.toLocaleString()}</td>
                    <td className="ss-td text-[color:var(--ss-text-dim)]">{s.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

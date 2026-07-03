import { useUIStore, type EdgeKindFilter } from "../../store/uiStore";

const LAYERS: { id: EdgeKindFilter; label: string; color: string; note: string }[] = [
  {
    id: "electrical",
    label: "Electrical connections",
    color: "#e08600",
    note: "Battery, DC-DC, e-motor supply lines (also covers thermal/fluid in v1)",
  },
  {
    id: "mechanical",
    label: "Mechanical connections",
    color: "#3f4650",
    note: "Shafts, propeller and wheel couplings",
  },
  {
    id: "signal",
    label: "Signal / data bus connections",
    color: "#0e7490",
    note: "Dashed lines — driving tasks, sensor and demand signals",
  },
];

export function LayerConfigPanel() {
  const visibleKinds = useUIStore((s) => s.visibleKinds);
  const toggleKind = useUIStore((s) => s.toggleKind);

  return (
    <div className="flex h-full flex-col">
      <div className="ss-panel-toolbar text-[11px] text-[color:var(--ss-text-dim)]">
        Configure which connection layers are drawn on the Topology canvas.
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="ss-th w-[52px]">Visible</th>
              <th className="ss-th w-[220px]">Layer</th>
              <th className="ss-th">Contents</th>
            </tr>
          </thead>
          <tbody>
            {LAYERS.map((l) => (
              <tr key={l.id} className="hover:bg-[#eef2f7]">
                <td className="ss-td text-center">
                  <input
                    type="checkbox"
                    checked={visibleKinds[l.id]}
                    onChange={() => toggleKind(l.id)}
                  />
                </td>
                <td className="ss-td">
                  <span className="flex items-center gap-2">
                    <span
                      className="inline-block h-[3px] w-6"
                      style={{
                        background: l.color,
                        ...(l.id === "signal"
                          ? {
                              backgroundImage: `repeating-linear-gradient(90deg, ${l.color} 0 6px, transparent 6px 9px)`,
                              backgroundColor: "transparent",
                            }
                          : {}),
                      }}
                    />
                    {l.label}
                  </span>
                </td>
                <td className="ss-td text-[11px] text-[color:var(--ss-text-dim)]">{l.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

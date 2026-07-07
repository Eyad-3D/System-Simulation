import { ListChecks, Loader2 } from "lucide-react";
import { useProjectStore } from "../../store/projectStore";
import { levelIcon } from "./MessagesPanel";

export function DataChecksPanel() {
  const dataChecks = useProjectStore((s) => s.dataChecks);
  const checking = useProjectStore((s) => s.checking);
  const runDataChecks = useProjectStore((s) => s.runDataChecks);
  const project = useProjectStore((s) => s.project);
  const select = useProjectStore((s) => s.select);
  const setActiveSystem = useProjectStore((s) => s.setActiveSystem);

  const jumpTo = (elementId?: string | null) => {
    if (!elementId || !project) return;
    const sys = project.systems.find((s) => s.elements.some((e) => e.id === elementId));
    if (sys) {
      setActiveSystem(sys.id);
      select(elementId);
    }
  };

  const errors = dataChecks?.filter((c) => c.level === "error").length ?? 0;
  const warnings = dataChecks?.filter((c) => c.level === "warning").length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="ss-panel-toolbar">
        <button
          className="ss-toolbtn border border-[color:var(--ss-border)]"
          disabled={checking}
          onClick={() => void runDataChecks()}
        >
          {checking ? <Loader2 size={13} className="animate-spin" /> : <ListChecks size={13} />}
          Run Data Checks
        </button>
        {dataChecks && (
          <span className="ml-2 text-[11px] text-[color:var(--ss-text-dim)]">
            {errors} error(s), {warnings} warning(s), {dataChecks.length - errors - warnings} info
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!dataChecks && (
          <div className="px-3 py-2 text-[12px] text-[color:var(--ss-text-dim)]">
            Data checks validate the model before a run (unconnected ports, missing
            parameters, unreachable power sources …). Click “Run Data Checks”.
          </div>
        )}
        {dataChecks && (
          <table className="w-full border-collapse">
            <thead className="sticky top-0">
              <tr>
                <th className="ss-th w-[40px]">Level</th>
                <th className="ss-th w-[180px]">Element</th>
                <th className="ss-th">Check</th>
              </tr>
            </thead>
            <tbody>
              {dataChecks.map((c, i) => (
                <tr
                  key={i}
                  className={`cursor-pointer hover:bg-[color:var(--ss-hover)] ${
                    c.level === "error"
                      ? "bg-red-50 dark:bg-red-950/40"
                      : c.level === "warning"
                        ? "bg-amber-50 dark:bg-amber-950/40"
                        : ""
                  }`}
                  onClick={() => jumpTo(c.elementId)}
                  title={c.elementId ? "Click to select this element" : undefined}
                >
                  <td className="ss-td text-center">{levelIcon(c.level)}</td>
                  <td className="ss-td truncate text-[11px]">{c.elementLabel ?? "—"}</td>
                  <td className="ss-td">{c.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

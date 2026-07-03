import { CloudOff, Loader2, Plus } from "lucide-react";
import { useProjectStore } from "../store/projectStore";

export function StatusBar() {
  const project = useProjectStore((s) => s.project);
  const offline = useProjectStore((s) => s.offline);
  const running = useProjectStore((s) => s.running);
  const dirty = useProjectStore((s) => s.dirty);
  const newProject = useProjectStore((s) => s.newProject);
  const messages = useProjectStore((s) => s.messages);
  const errors = messages.filter((m) => m.level === "error").length;
  const elementCount =
    project?.systems.reduce((n, s) => n + s.elements.length, 0) ?? 0;

  return (
    <div className="flex h-[26px] shrink-0 items-center border-t border-[color:var(--ss-border)] bg-[color:var(--ss-chrome)] text-[11px]">
      <div className="flex h-full items-end gap-0.5 px-1.5">
        {project && (
          <div className="flex h-[22px] items-center gap-2 rounded-t border border-b-0 border-[color:var(--ss-border)] bg-white px-3 font-medium">
            {project.name}
            {dirty && <span className="text-[color:var(--ss-accent)]">•</span>}
          </div>
        )}
        <button
          className="mb-0.5 rounded p-0.5 hover:bg-[#dbe2ea]"
          title="New project"
          onClick={() => {
            if (!dirty || window.confirm("Discard unsaved changes and create a new project?")) {
              newProject();
            }
          }}
        >
          <Plus size={13} />
        </button>
      </div>
      <div className="ml-auto flex items-center gap-3 px-3 text-[color:var(--ss-text-dim)]">
        {running && (
          <span className="flex items-center gap-1 text-[color:var(--ss-accent)]">
            <Loader2 size={12} className="animate-spin" /> solving…
          </span>
        )}
        {errors > 0 && <span className="text-red-600">{errors} error(s)</span>}
        <span>{elementCount} elements</span>
        {offline ? (
          <span className="flex items-center gap-1 text-amber-600">
            <CloudOff size={12} /> backend offline
          </span>
        ) : (
          <span className="text-emerald-700">backend connected</span>
        )}
      </div>
    </div>
  );
}

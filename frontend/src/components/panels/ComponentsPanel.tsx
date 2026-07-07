import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useProjectStore } from "../../store/projectStore";
import { componentIcon } from "../../icons";
import type { ComponentDef } from "../../types";

export function ComponentsPanel() {
  const library = useProjectStore((s) => s.library);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? library.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.category.toLowerCase().includes(q) ||
            c.id.toLowerCase().includes(q),
        )
      : library;
    const byCat = new Map<string, ComponentDef[]>();
    for (const c of filtered) {
      if (!byCat.has(c.category)) byCat.set(c.category, []);
      byCat.get(c.category)!.push(c);
    }
    return [...byCat.entries()];
  }, [library, query]);

  return (
    <div className="flex h-full flex-col">
      <div className="ss-panel-toolbar">
        <Search size={13} className="text-[color:var(--ss-text-dim)]" />
        <input
          className="ss-input flex-1"
          placeholder="Search components…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {groups.map(([category, defs]) => {
          const isCollapsed = collapsed.has(category) && !query;
          return (
            <div key={category}>
              <button
                className="ss-tree-row font-semibold"
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(category)) next.delete(category);
                    else next.add(category);
                    return next;
                  })
                }
              >
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                {category}
                <span className="ml-auto pr-1 text-[10px] font-normal text-[color:var(--ss-text-dim)]">
                  {defs.length}
                </span>
              </button>
              {!isCollapsed &&
                defs.map((def) => {
                  const Icon = componentIcon(def.icon);
                  return (
                    <div
                      key={def.id}
                      className="ss-tree-row cursor-grab pl-6 active:cursor-grabbing"
                      draggable
                      title={def.description ?? def.name}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("application/simstudio", def.id);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                    >
                      <Icon size={14} strokeWidth={1.6} className="shrink-0 text-[color:var(--ss-node-icon)]" />
                      <span className="truncate">{def.name}</span>
                      <span className="ml-auto pr-1 text-[9px] uppercase text-[color:var(--ss-text-dim)]">
                        {def.domain.slice(0, 4)}
                      </span>
                    </div>
                  );
                })}
            </div>
          );
        })}
        {groups.length === 0 && (
          <div className="px-3 py-2 text-[12px] text-[color:var(--ss-text-dim)]">
            No components match “{query}”.
          </div>
        )}
      </div>
      <div className="border-t border-[color:var(--ss-border)] px-2 py-1 text-[10px] text-[color:var(--ss-text-dim)]">
        Drag a component onto the Topology canvas to add it.
      </div>
    </div>
  );
}

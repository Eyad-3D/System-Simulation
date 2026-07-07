import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection as RFConnection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
} from "@xyflow/react";
import {
  Bookmark,
  ChevronRight,
  Grid2x2,
  Map,
  Maximize,
  Redo2,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  systemBreadcrumb,
  useActiveSystem,
  useProjectStore,
} from "../../store/projectStore";
import { useUIStore } from "../../store/uiStore";
import type { PortKind } from "../../types";
import { ElementNode, type ElementFlowNode } from "./ElementNode";

const nodeTypes = { element: ElementNode };

const KIND_COLOR: Record<PortKind, string> = {
  electrical: "#e08600",
  mechanical: "#3f4650",
  signal: "#0e7490",
  thermal: "#c2410c",
  fluid: "#2563eb",
  power: "#e08600",
};

function TopologyCanvasInner() {
  const project = useProjectStore((s) => s.project);
  const libraryById = useProjectStore((s) => s.libraryById);
  const activeSystemId = useProjectStore((s) => s.activeSystemId);
  const selectedElementId = useProjectStore((s) => s.selectedElementId);
  const system = useActiveSystem();
  const store = useProjectStore;
  const visibleKinds = useUIStore((s) => s.visibleKinds);
  const { fitView, zoomIn, zoomOut, screenToFlowPosition } = useReactFlow();

  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const [showMiniMap, setShowMiniMap] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const theme = useUIStore((s) => s.theme);

  // sync external selection (properties tree, elements list) into the canvas
  useEffect(() => {
    setSelectedNodes(selectedElementId ? new Set([selectedElementId]) : new Set());
  }, [selectedElementId]);

  useEffect(() => {
    const t = setTimeout(() => void fitView({ padding: 0.15, duration: 200 }), 120);
    return () => clearTimeout(t);
  }, [activeSystemId, fitView]);

  // re-fit while the dock layout settles after initial mount (panel widths are
  // applied a few frames after the flow instance measures itself)
  useEffect(() => {
    const timers = [400, 900].map((ms) =>
      setTimeout(() => void fitView({ padding: 0.15 }), ms),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nodes: ElementFlowNode[] = useMemo(() => {
    if (!system) return [];
    return system.elements
      .filter((el) => libraryById[el.componentDefId])
      .map((el) => ({
        id: el.id,
        type: "element" as const,
        position: el.position,
        data: { element: el, def: libraryById[el.componentDefId] },
        selected: selectedNodes.has(el.id),
      }));
  }, [system, libraryById, selectedNodes]);

  const edges: Edge[] = useMemo(() => {
    if (!system || !project) return [];
    const portKind = (elId: string, portId: string): PortKind => {
      const el = system.elements.find((e) => e.id === elId);
      const def = el && libraryById[el.componentDefId];
      return def?.ports.find((p) => p.id === portId)?.kind ?? "power";
    };
    // signal / data-bus wiring is not drawn on the canvas — see the
    // Data Bus Connections panel
    const out: Edge[] = [];
    for (const c of system.connections) {
      const kind = portKind(c.sourceElementId, c.sourcePortId);
      if (kind === "signal") continue;
      const filterKey = kind === "mechanical" ? "mechanical" : "electrical";
      if (!visibleKinds[filterKey]) continue;
      out.push({
        id: c.id,
        source: c.sourceElementId,
        sourceHandle: c.sourcePortId,
        target: c.targetElementId,
        targetHandle: c.targetPortId,
        type: "smoothstep",
        style: { stroke: KIND_COLOR[kind] },
        selected: selectedEdges.has(c.id),
      });
    }
    return out;
  }, [system, project, libraryById, visibleKinds, selectedEdges]);

  const onNodesChange = useCallback(
    (changes: NodeChange<ElementFlowNode>[]) => {
      const sel = new Set(selectedNodes);
      let selChanged = false;
      for (const ch of changes) {
        if (ch.type === "position" && ch.position) {
          store.getState().moveElement(ch.id, ch.position);
        } else if (ch.type === "select") {
          selChanged = true;
          if (ch.selected) sel.add(ch.id);
          else sel.delete(ch.id);
        }
      }
      if (selChanged) {
        setSelectedNodes(sel);
        const st = store.getState();
        const single = sel.size >= 1 ? [...sel][sel.size - 1] : null;
        if (st.selectedElementId !== single) st.select(single);
      }
    },
    [selectedNodes, store],
  );

  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    setSelectedEdges((prev) => {
      const sel = new Set(prev);
      for (const ch of changes) {
        if (ch.type === "select") {
          if (ch.selected) sel.add(ch.id);
          else sel.delete(ch.id);
        }
      }
      return sel;
    });
  }, []);

  const portOf = useCallback(
    (elId: string | null, portId: string | null | undefined) => {
      if (!elId || !portId || !system) return null;
      const el = system.elements.find((e) => e.id === elId);
      const def = el && libraryById[el.componentDefId];
      return def?.ports.find((p) => p.id === portId) ?? null;
    },
    [system, libraryById],
  );

  const isValidConnection: IsValidConnection = useCallback(
    (conn) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return false;
      const a = portOf(conn.source, conn.sourceHandle);
      const b = portOf(conn.target, conn.targetHandle);
      if (!a || !b) return false;
      // signals are wired in the Data Bus Connections panel, not on canvas
      if (a.kind === "signal" || b.kind === "signal") return false;
      return a.kind === b.kind;
    },
    [portOf],
  );

  const onConnect = useCallback(
    (conn: RFConnection) => {
      if (!conn.source || !conn.target || !conn.sourceHandle || !conn.targetHandle) return;
      store
        .getState()
        .addConnection(conn.source, conn.sourceHandle, conn.target, conn.targetHandle);
    },
    [store],
  );

  const deleteSelection = useCallback(() => {
    const st = store.getState();
    if (selectedEdges.size > 0) st.removeConnections([...selectedEdges]);
    if (selectedNodes.size > 0) st.removeElements([...selectedNodes]);
    setSelectedEdges(new Set());
    setSelectedNodes(new Set());
  }, [selectedEdges, selectedNodes, store]);

  const breadcrumb = project && activeSystemId ? systemBreadcrumb(project, activeSystemId) : [];
  const past = useProjectStore((s) => s.past.length);
  const future = useProjectStore((s) => s.future.length);

  return (
    <div className="flex h-full flex-col">
      <div className="ss-panel-toolbar justify-between">
        <div className="flex min-w-0 items-center gap-0.5 text-[12px]">
          {breadcrumb.map((sys, i) => (
            <span key={sys.id} className="flex min-w-0 items-center gap-0.5">
              {i > 0 && <ChevronRight size={12} className="shrink-0 text-[color:var(--ss-text-dim)]" />}
              <button
                className={`truncate rounded px-1 py-0.5 hover:bg-[color:var(--ss-hover)] ${
                  i === breadcrumb.length - 1
                    ? "font-semibold text-[color:var(--ss-accent)]"
                    : "text-[color:var(--ss-text-dim)]"
                }`}
                onClick={() => store.getState().setActiveSystem(sys.id)}
              >
                {sys.name}
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          <button className="ss-toolbtn" title="Zoom in" onClick={() => void zoomIn()}>
            <ZoomIn size={14} />
          </button>
          <button className="ss-toolbtn" title="Zoom out" onClick={() => void zoomOut()}>
            <ZoomOut size={14} />
          </button>
          <button
            className="ss-toolbtn"
            title="Fit to screen"
            onClick={() => void fitView({ padding: 0.15, duration: 200 })}
          >
            <Maximize size={14} />
          </button>
          <div className="mx-1 h-4 w-px bg-[color:var(--ss-border)]" />
          <button
            className="ss-toolbtn"
            title="Undo (Ctrl+Z)"
            disabled={past === 0}
            onClick={() => store.getState().undo()}
          >
            <Undo2 size={14} />
          </button>
          <button
            className="ss-toolbtn"
            title="Redo (Ctrl+Y)"
            disabled={future === 0}
            onClick={() => store.getState().redo()}
          >
            <Redo2 size={14} />
          </button>
          <div className="mx-1 h-4 w-px bg-[color:var(--ss-border)]" />
          <button
            className="ss-toolbtn"
            title="Delete selection (Del)"
            disabled={selectedNodes.size === 0 && selectedEdges.size === 0}
            onClick={deleteSelection}
          >
            <Trash2 size={14} />
          </button>
          <button
            className={`ss-toolbtn ${showGrid ? "bg-[color:var(--ss-active)]" : ""}`}
            title="Toggle background grid"
            onClick={() => setShowGrid((v) => !v)}
          >
            <Grid2x2 size={14} />
          </button>
          <button
            className={`ss-toolbtn ${showMiniMap ? "bg-[color:var(--ss-active)]" : ""}`}
            title="Toggle minimap"
            onClick={() => setShowMiniMap((v) => !v)}
          >
            <Map size={14} />
          </button>
          <button className="ss-toolbtn" title="Bookmarks (not in v1)" disabled>
            <Bookmark size={14} />
          </button>
        </div>
      </div>
      <div
        className="relative min-h-0 flex-1"
        onDoubleClick={(e) => {
          // Coordinate hit-test: the second click of a double-click can land
          // on the pane while React re-renders the selection, so relying on
          // onNodeDoubleClick alone is not enough. Containers drill in;
          // everything else opens the parameter dialog.
          if (!system) return;
          const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
          const hit = system.elements.find(
            (el) =>
              pos.x >= el.position.x - 6 &&
              pos.x <= el.position.x + 98 &&
              pos.y >= el.position.y - 6 &&
              pos.y <= el.position.y + 84,
          );
          if (!hit) return;
          if (hit.isSubSystem && hit.subSystemId) {
            store.getState().setActiveSystem(hit.subSystemId);
          } else {
            useUIStore.getState().openParamDialog(hit.id);
          }
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onNodeDragStart={() => store.getState().beginHistory()}
          onNodeDoubleClick={(_, node) => {
            const el = node.data.element;
            if (el.isSubSystem && el.subSystemId) {
              store.getState().setActiveSystem(el.subSystemId);
            } else {
              useUIStore.getState().openParamDialog(el.id);
            }
          }}
          onNodesDelete={(deleted) =>
            store.getState().removeElements(deleted.map((n) => n.id))
          }
          onEdgesDelete={(deleted) =>
            store.getState().removeConnections(deleted.map((e) => e.id))
          }
          onPaneClick={() => {
            setSelectedNodes(new Set());
            setSelectedEdges(new Set());
            store.getState().select(null);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(e) => {
            e.preventDefault();
            const defId = e.dataTransfer.getData("application/simstudio");
            if (!defId) return;
            const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
            store.getState().addElement(defId, { x: pos.x - 46, y: pos.y - 27 });
          }}
          deleteKeyCode={["Delete", "Backspace"]}
          nodeDragThreshold={4}
          zoomOnDoubleClick={false}
          colorMode={theme}
          fitView
          minZoom={0.15}
          maxZoom={2.5}
          proOptions={{ hideAttribution: false }}
        >
          {showGrid && (
            <Background
              variant={BackgroundVariant.Lines}
              gap={22}
              color={theme === "dark" ? "#262b33" : "#eceff3"}
            />
          )}
          {showMiniMap && (
            <MiniMap
              pannable
              zoomable
              className="!h-[96px] !w-[150px] rounded border border-[color:var(--ss-border)] shadow-sm"
              bgColor={theme === "dark" ? "#1b1f26" : "#f2f4f8"}
              maskColor={theme === "dark" ? "rgba(90, 150, 210, 0.12)" : "rgba(47, 111, 179, 0.09)"}
              nodeColor={theme === "dark" ? "#55606f" : "#7e8ca0"}
              nodeStrokeColor={theme === "dark" ? "#8a95a5" : "#5b6472"}
            />
          )}
        </ReactFlow>
        {system && system.elements.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-[color:var(--ss-text-dim)]">
            Drag components from the library onto the canvas to build the topology.
          </div>
        )}
      </div>
    </div>
  );
}

export function TopologyCanvas() {
  return (
    <ReactFlowProvider>
      <TopologyCanvasInner />
    </ReactFlowProvider>
  );
}

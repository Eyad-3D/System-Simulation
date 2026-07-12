import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  ViewportPortal,
  type Connection as RFConnection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
} from "@xyflow/react";
import {
  Bookmark,
  BoxSelect,
  ChevronRight,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Grid2x2,
  Magnet,
  Map,
  Maximize,
  Pencil,
  Redo2,
  Settings2,
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
import { promptDialog } from "../../dialog";
import type { PortKind } from "../../types";
import { ElementNode, type ElementFlowNode } from "./ElementNode";

const nodeTypes = { element: ElementNode };

const GRID = 22; // background grid gap; snap uses the same pitch
const ALIGN_THRESH = 5; // flow-unit tolerance for alignment guides
const DEFAULT_W = 92;
const DEFAULT_H = 78;

type CtxMenu = { x: number; y: number; nodeId: string | null };

function MenuBtn({
  icon: Icon,
  label,
  onClick,
  kbd,
  disabled,
  danger,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  onClick: () => void;
  kbd?: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      className={`flex w-full items-center gap-2 px-2.5 py-1 text-left hover:bg-[color:var(--ss-hover)] disabled:opacity-40 disabled:hover:bg-transparent ${
        danger ? "text-red-600" : ""
      }`}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={13} className="shrink-0" />
      <span className="flex-1">{label}</span>
      {kbd && <span className="text-[10px] text-[color:var(--ss-text-dim)]">{kbd}</span>}
    </button>
  );
}

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
  const [snap, setSnap] = useState(false);
  const [menu, setMenu] = useState<CtxMenu | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] } | null>(null);
  const theme = useUIStore((s) => s.theme);

  const pendingSelection = useProjectStore((s) => s.pendingCanvasSelection);
  const clipboard = useProjectStore((s) => s.clipboard);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const hovered = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);

  // apply a store-requested selection (e.g. freshly pasted/duplicated elements)
  useEffect(() => {
    if (!pendingSelection) return;
    setSelectedNodes(new Set(pendingSelection));
    store.getState().clearPendingSelection();
  }, [pendingSelection, store]);

  // sync external selection (properties tree, elements list) into the canvas.
  // Must not collapse a canvas-originated multi-selection: when the selected
  // element is already part of the current canvas selection, leave it alone;
  // only a genuinely new (external) selection replaces it with a single node.
  useEffect(() => {
    setSelectedNodes((prev) => {
      if (!selectedElementId) return prev.size ? new Set() : prev;
      if (prev.has(selectedElementId)) return prev;
      return new Set([selectedElementId]);
    });
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

  // Signal / data-bus links as a dashed overlay (render-only). These are stored
  // globally in project.dataBusConnections, not as canvas edges; we draw a
  // border-to-border dashed line between the two node boxes so control loops
  // are visible. Toggled via the "signal" layer in Layer Configurations.
  const signalEdges = useMemo(() => {
    if (!system || !project || !visibleKinds.signal) return [];
    // NB: `Map` is shadowed by the lucide-react Map icon in this file — use a record.
    const inSys: Record<string, (typeof system.elements)[number]> = {};
    for (const e of system.elements) inSys[e.id] = e;
    const box = (el: (typeof system.elements)[number]) => {
      const w = el.size?.width ?? DEFAULT_W;
      const h = el.size?.height ?? 64;
      return { cx: el.position.x + w / 2, cy: el.position.y + h / 2, hw: w / 2, hh: h / 2 };
    };
    const out: { id: string; x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const d of project.dataBusConnections) {
      const a = inSys[d.element1Id];
      const b = inSys[d.element2Id];
      if (!a || !b) continue;
      const ba = box(a);
      const bb = box(b);
      const dx = bb.cx - ba.cx;
      const dy = bb.cy - ba.cy;
      if (dx === 0 && dy === 0) continue;
      const adx = Math.abs(dx) || 1e-6;
      const ady = Math.abs(dy) || 1e-6;
      const t0 = Math.min(ba.hw / adx, ba.hh / ady); // exit source box
      const t1 = Math.min(bb.hw / adx, bb.hh / ady); // enter target box
      out.push({
        id: d.id,
        x1: ba.cx + dx * t0,
        y1: ba.cy + dy * t0,
        x2: bb.cx - dx * t1,
        y2: bb.cy - dy * t1,
      });
    }
    return out;
  }, [system, project, visibleKinds]);

  const onNodesChange = useCallback(
    (changes: NodeChange<ElementFlowNode>[]) => {
      const sel = new Set(selectedNodes);
      let selChanged = false;
      for (const ch of changes) {
        if (ch.type === "position" && ch.position) {
          store.getState().moveElement(ch.id, ch.position);
        } else if (ch.type === "dimensions" && "resizing" in ch && ch.dimensions) {
          // NodeResizer-driven resize (auto-measure changes have no `resizing` flag)
          store.getState().resizeElement(ch.id, ch.dimensions);
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

  // reconnect an existing edge to a different port (same kind only)
  const onReconnect = useCallback(
    (oldEdge: Edge, conn: RFConnection) => {
      if (!conn.source || !conn.target || !conn.sourceHandle || !conn.targetHandle) return;
      const a = portOf(conn.source, conn.sourceHandle);
      const b = portOf(conn.target, conn.targetHandle);
      if (!a || !b || a.kind === "signal" || a.kind !== b.kind) return; // invalid → keep old edge
      const st = store.getState();
      st.removeConnections([oldEdge.id]);
      st.addConnection(conn.source, conn.sourceHandle, conn.target, conn.targetHandle);
    },
    [portOf, store],
  );

  // --- alignment guides while dragging (visual; snapping stays on the grid) ---
  const onNodeDrag = useCallback(
    (_: unknown, node: ElementFlowNode) => {
      if (!system) return;
      const w = node.measured?.width ?? DEFAULT_W;
      const h = node.measured?.height ?? DEFAULT_H;
      const aXs = [node.position.x, node.position.x + w / 2, node.position.x + w];
      const aYs = [node.position.y, node.position.y + h / 2, node.position.y + h];
      const gx = new Set<number>();
      const gy = new Set<number>();
      for (const el of system.elements) {
        if (el.id === node.id) continue;
        const ew = el.size?.width ?? DEFAULT_W;
        const eh = el.size?.height ?? DEFAULT_H;
        const bXs = [el.position.x, el.position.x + ew / 2, el.position.x + ew];
        const bYs = [el.position.y, el.position.y + eh / 2, el.position.y + eh];
        for (const a of aXs) for (const b of bXs) if (Math.abs(a - b) <= ALIGN_THRESH) gx.add(b);
        for (const a of aYs) for (const b of bYs) if (Math.abs(a - b) <= ALIGN_THRESH) gy.add(b);
      }
      setGuides(gx.size || gy.size ? { x: [...gx], y: [...gy] } : null);
    },
    [system],
  );
  const onNodeDragStop = useCallback(() => setGuides(null), []);

  // context-menu helpers -----------------------------------------------------
  const openMenuAt = (clientX: number, clientY: number, nodeId: string | null) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    setMenu({ x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0), nodeId });
  };
  const closeMenu = () => setMenu(null);

  // copy / duplicate / paste keyboard shortcuts (only while over the canvas)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hovered.current) return;
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable) return;
      const st = store.getState();
      const k = e.key.toLowerCase();
      if (k === "c" && selectedNodes.size > 0) {
        st.copyElements([...selectedNodes]);
      } else if (k === "d" && selectedNodes.size > 0) {
        e.preventDefault();
        st.duplicateElements([...selectedNodes]);
      } else if (k === "v" && st.clipboard) {
        e.preventDefault();
        st.pasteClipboard(pointer.current ?? undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedNodes, store]);

  // close the context menu on Escape / outside interactions
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeMenu();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

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
            className={`ss-toolbtn ${snap ? "bg-[color:var(--ss-active)]" : ""}`}
            title="Snap elements to the grid while dragging"
            onClick={() => setSnap((v) => !v)}
          >
            <Magnet size={14} />
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
        ref={wrapperRef}
        className="relative min-h-0 flex-1"
        onMouseEnter={() => (hovered.current = true)}
        onMouseLeave={() => (hovered.current = false)}
        onMouseMove={(e) => {
          pointer.current = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        }}
        onDoubleClick={(e) => {
          // Coordinate hit-test: the second click of a double-click can land
          // on the pane while React re-renders the selection, so relying on
          // onNodeDoubleClick alone is not enough. Containers drill in;
          // everything else opens the parameter dialog.
          if (!system) return;
          const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
          const hit = system.elements.find((el) => {
            const w = el.size?.width ?? 92;
            const h = el.size?.height ?? 78;
            return (
              pos.x >= el.position.x - 6 &&
              pos.x <= el.position.x + w + 6 &&
              pos.y >= el.position.y - 6 &&
              pos.y <= el.position.y + h + 6
            );
          });
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
          onReconnect={onReconnect}
          isValidConnection={isValidConnection}
          onNodeDragStart={() => store.getState().beginHistory()}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onNodeContextMenu={(e, node) => {
            e.preventDefault();
            if (!selectedNodes.has(node.id)) {
              setSelectedNodes(new Set([node.id]));
              store.getState().select(node.id);
            }
            openMenuAt(e.clientX, e.clientY, node.id);
          }}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            openMenuAt(
              (e as React.MouseEvent).clientX,
              (e as React.MouseEvent).clientY,
              null,
            );
          }}
          snapToGrid={snap}
          snapGrid={[GRID, GRID]}
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
            closeMenu();
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
          multiSelectionKeyCode={["Control", "Meta", "Shift"]}
          selectionKeyCode={["Shift"]}
          selectNodesOnDrag
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
              gap={GRID}
              color={theme === "dark" ? "#262b33" : "#eceff3"}
            />
          )}
          {signalEdges.length > 0 && (
            <ViewportPortal>
              <svg
                className="pointer-events-none absolute left-0 top-0 overflow-visible"
                style={{ width: 1, height: 1 }}
              >
                {signalEdges.map((e) => (
                  <line
                    key={e.id}
                    x1={e.x1}
                    y1={e.y1}
                    x2={e.x2}
                    y2={e.y2}
                    stroke={KIND_COLOR.signal}
                    strokeWidth={1.6}
                    strokeDasharray="5 4"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                    opacity={0.85}
                  />
                ))}
              </svg>
            </ViewportPortal>
          )}
          {guides && (
            <ViewportPortal>
              {guides.x.map((x) => (
                <div
                  key={`gx-${x}`}
                  className="pointer-events-none absolute"
                  style={{
                    left: x,
                    top: -100000,
                    width: 1,
                    height: 200000,
                    background: "var(--ss-accent)",
                    opacity: 0.7,
                  }}
                />
              ))}
              {guides.y.map((y) => (
                <div
                  key={`gy-${y}`}
                  className="pointer-events-none absolute"
                  style={{
                    top: y,
                    left: -100000,
                    height: 1,
                    width: 200000,
                    background: "var(--ss-accent)",
                    opacity: 0.7,
                  }}
                />
              ))}
            </ViewportPortal>
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
        {menu && (
          <div
            className="absolute z-50 min-w-[176px] rounded-md border border-[color:var(--ss-border)] bg-[color:var(--ss-panel)] py-1 shadow-lg"
            style={{
              left: Math.min(menu.x, (wrapperRef.current?.clientWidth ?? 9999) - 184),
              top: Math.min(menu.y, (wrapperRef.current?.clientHeight ?? 9999) - 200),
            }}
          >
            {menu.nodeId ? (
              <>
                <MenuBtn
                  icon={Settings2}
                  label="Parameters"
                  onClick={() => {
                    const el = system?.elements.find((e) => e.id === menu.nodeId);
                    if (el?.isSubSystem && el.subSystemId) store.getState().setActiveSystem(el.subSystemId);
                    else useUIStore.getState().openParamDialog(menu.nodeId!);
                    closeMenu();
                  }}
                />
                <MenuBtn
                  icon={Pencil}
                  label="Rename…"
                  onClick={() => {
                    const el = system?.elements.find((e) => e.id === menu.nodeId);
                    const id = menu.nodeId!;
                    closeMenu();
                    void promptDialog({
                      title: "Rename element",
                      defaultValue: el?.label ?? "",
                      confirmLabel: "Rename",
                    }).then((name) => {
                      if (name != null && name.trim()) store.getState().renameElement(id, name.trim());
                    });
                  }}
                />
                <div className="my-1 h-px bg-[color:var(--ss-border)]" />
                <MenuBtn
                  icon={CopyPlus}
                  label={`Duplicate${selectedNodes.size > 1 ? ` (${selectedNodes.size})` : ""}`}
                  kbd="Ctrl+D"
                  onClick={() => {
                    store.getState().duplicateElements([...selectedNodes]);
                    closeMenu();
                  }}
                />
                <MenuBtn
                  icon={Copy}
                  label={`Copy${selectedNodes.size > 1 ? ` (${selectedNodes.size})` : ""}`}
                  kbd="Ctrl+C"
                  onClick={() => {
                    store.getState().copyElements([...selectedNodes]);
                    closeMenu();
                  }}
                />
                <div className="my-1 h-px bg-[color:var(--ss-border)]" />
                <MenuBtn
                  icon={Trash2}
                  label={`Delete${selectedNodes.size > 1 ? ` (${selectedNodes.size})` : ""}`}
                  kbd="Del"
                  danger
                  onClick={() => {
                    deleteSelection();
                    closeMenu();
                  }}
                />
              </>
            ) : (
              <>
                <MenuBtn
                  icon={ClipboardPaste}
                  label="Paste"
                  kbd="Ctrl+V"
                  disabled={!clipboard}
                  onClick={() => {
                    store.getState().pasteClipboard(pointer.current ?? undefined);
                    closeMenu();
                  }}
                />
                <MenuBtn
                  icon={BoxSelect}
                  label="Select all"
                  onClick={() => {
                    if (system) setSelectedNodes(new Set(system.elements.map((e) => e.id)));
                    closeMenu();
                  }}
                />
                <MenuBtn
                  icon={Maximize}
                  label="Fit view"
                  onClick={() => {
                    void fitView({ padding: 0.15, duration: 200 });
                    closeMenu();
                  }}
                />
              </>
            )}
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

import { memo, useMemo, useRef, useState } from "react";
import {
  Handle,
  NodeResizer,
  Position,
  type NodeProps,
  type Node,
} from "@xyflow/react";
import { AlertTriangle } from "lucide-react";
import type { ComponentDef, ElementInstance, PortDef, PortSide } from "../../types";
import { useProjectStore } from "../../store/projectStore";
import { componentIcon } from "../../icons";

export type ElementNodeData = {
  element: ElementInstance;
  def: ComponentDef;
};

export type ElementFlowNode = Node<ElementNodeData, "element">;

export const DEFAULT_NODE_WIDTH = 92;

const POSITION_OF: Record<PortSide, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
};

const NEXT_SIDE: Record<PortSide, PortSide> = {
  left: "top",
  top: "right",
  right: "bottom",
  bottom: "left",
};

type Placement = { side: PortSide; frac: number };

/** Nearest node edge + offset (0..1 along that edge) for a screen point. */
function placementFromPoint(rect: DOMRect, clientX: number, clientY: number): Placement {
  const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  const d = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  const side = (Object.keys(d) as PortSide[]).reduce((a, b) => (d[b] < d[a] ? b : a));
  const frac = side === "top" || side === "bottom" ? x : y;
  return { side, frac: Math.min(0.92, Math.max(0.08, frac)) };
}

function handleClass(kind: PortDef["kind"]): string {
  return `ss-handle-${kind}`;
}

function polarityGlyphStyle(side: PortSide, offset: string): React.CSSProperties {
  switch (side) {
    case "left":
      return { left: 3, top: offset, transform: "translateY(-50%)" };
    case "right":
      return { right: 3, top: offset, transform: "translateY(-50%)" };
    case "top":
      return { top: 2, left: offset, transform: "translateX(-50%)" };
    case "bottom":
      return { bottom: 2, left: offset, transform: "translateX(-50%)" };
  }
}

/** A physical (non-signal) port: one interactive source handle that can both
 *  start and end connections, plus an invisible target handle underneath so
 *  incoming edges have an anchor of type 'target' at the same spot.
 *  Shift+drag repositions the pin freely; Shift+click (no drag) cycles side. */
function PhysicalPort({
  port,
  side,
  frac,
  boxRef,
  onCycle,
  onDragPreview,
  onDragCommit,
}: {
  port: PortDef;
  side: PortSide;
  frac: number;
  boxRef: React.RefObject<HTMLDivElement | null>;
  onCycle: (port: PortDef, next: PortSide) => void;
  onDragPreview: (portId: string, placement: Placement) => void;
  onDragCommit: (port: PortDef, placement: Placement | null) => void;
}) {
  const pos = POSITION_OF[side];
  const offset = `${frac * 100}%`;
  const style: React.CSSProperties =
    side === "top" || side === "bottom" ? { left: offset } : { top: offset };

  // Shift+drag repositions the pin. We intercept in the capture phase and stop
  // propagation so React Flow (which starts a connection on the handle's
  // onMouseDown) never fires; a plain drag falls through to start a connection.
  const startShiftDrag = (e: React.MouseEvent) => {
    if (!e.shiftKey) return;
    e.stopPropagation();
    e.preventDefault();
    useProjectStore.getState().beginHistory();
    const startX = e.clientX;
    const startY = e.clientY;
    let last: Placement | null = null;
    const onMove = (ev: MouseEvent) => {
      if (!boxRef.current) return;
      last = placementFromPoint(boxRef.current.getBoundingClientRect(), ev.clientX, ev.clientY);
      onDragPreview(port.id, last);
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp, true);
      const moved = Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY);
      if (moved < 4 || !last) onCycle(port, NEXT_SIDE[side]);
      else onDragCommit(port, last);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, true);
  };

  return (
    <>
      <Handle
        id={port.id}
        type="target"
        position={pos}
        style={{ ...style, pointerEvents: "none", opacity: 0 }}
        isConnectableStart={false}
      />
      <Handle
        id={port.id}
        type="source"
        position={pos}
        style={{ ...style, touchAction: "none" }}
        className={handleClass(port.kind)}
        isConnectableStart
        isConnectableEnd
        title={`${port.name} (${port.kind}) — Shift+drag to move the pin, Shift+click to flip side`}
        onMouseDownCapture={startShiftDrag}
      />
      {port.polarity && (
        <span
          className="pointer-events-none absolute z-10 text-[10px] font-bold leading-none"
          style={{
            ...polarityGlyphStyle(side, offset),
            color: port.polarity === "positive" ? "#dc2626" : "#2563eb",
          }}
        >
          {port.polarity === "positive" ? "+" : "−"}
        </span>
      )}
    </>
  );
}

export const ElementNode = memo(({ data, selected }: NodeProps<ElementFlowNode>) => {
  const { def, element } = data;
  const Icon = componentIcon(def.icon);
  const setPortSide = useProjectStore((s) => s.setPortSide);
  const setPortPlacement = useProjectStore((s) => s.setPortPlacement);
  const dataChecks = useProjectStore((s) => s.dataChecks);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // surface data-check errors/warnings for this element right on the node
  const issue = useMemo(() => {
    const forEl = dataChecks?.filter((c) => c.elementId === element.id) ?? [];
    if (forEl.length === 0) return null;
    const worst = forEl.some((c) => c.level === "error") ? "error" : forEl.some((c) => c.level === "warning") ? "warning" : null;
    if (!worst) return null;
    return { level: worst, text: forEl.map((c) => c.text).join("\n") } as const;
  }, [dataChecks, element.id]);
  // live pin position while Shift+dragging a port (committed to the store on release)
  const [preview, setPreview] = useState<{ portId: string; placement: Placement } | null>(null);

  // physical ports only — signal / data-bus wiring is managed in the
  // Data Bus Connections panel and is not drawn on the canvas
  const physical = def.ports.filter((p) => p.kind !== "signal");
  const sideOf = (p: PortDef): PortSide =>
    preview?.portId === p.id
      ? preview.placement.side
      : element.portSides?.[p.id] ?? ((p.side as PortSide) || "left");
  const bySide: Record<PortSide, PortDef[]> = { left: [], right: [], top: [], bottom: [] };
  for (const p of physical) bySide[sideOf(p)].push(p);

  const fracOf = (p: PortDef, index: number, count: number): number => {
    if (preview?.portId === p.id) return preview.placement.frac;
    const stored = element.portOffsets?.[p.id];
    if (typeof stored === "number") return stored;
    return (index + 1) / (count + 1);
  };

  const onCycle = (port: PortDef, next: PortSide) => setPortSide(element.id, port.id, next);

  const portRows = Math.max(bySide.left.length, bySide.right.length, 1);
  const defaultHeight = Math.max(54, portRows * 18 + 18);
  const width = element.size?.width ?? DEFAULT_NODE_WIDTH;
  const height = element.size?.height ?? defaultHeight;
  const isSub = element.isSubSystem;

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={56}
        minHeight={40}
        onResizeStart={() => useProjectStore.getState().beginHistory()}
        lineClassName="ss-resize-line"
        handleClassName="ss-resize-handle"
      />
      <div
        ref={boxRef}
        className={`group relative flex items-center justify-center rounded-md border bg-[color:var(--ss-panel)] shadow-sm transition-shadow
          ${isSub ? "border-dashed border-[color:var(--ss-accent)] bg-[color:var(--ss-accent-soft)]" : "border-[color:var(--ss-node-border)]"}
          ${selected ? "outline outline-2 outline-[color:var(--ss-accent)] shadow-md" : issue?.level === "error" ? "outline outline-2 outline-red-500" : issue?.level === "warning" ? "outline outline-1 outline-amber-500" : ""}`}
        style={{ width, height }}
        title={isSub ? "Double-click to open sub-system" : `${def.name} — double-click for parameters`}
      >
        {issue && (
          <span
            className={`absolute -right-1.5 -top-1.5 z-20 flex h-3.5 w-3.5 items-center justify-center rounded-full text-white shadow ${
              issue.level === "error" ? "bg-red-500" : "bg-amber-500"
            }`}
            title={issue.text}
          >
            <AlertTriangle size={9} strokeWidth={2.5} />
          </span>
        )}
        <Icon
          size={isSub ? 26 : 30}
          strokeWidth={1.5}
          className={isSub ? "text-[color:var(--ss-accent)]" : "text-[color:var(--ss-node-icon)]"}
        />
        {isSub && (
          <span className="absolute bottom-0.5 right-1 text-[8px] font-semibold uppercase tracking-wide text-[color:var(--ss-accent)]">
            SYS
          </span>
        )}
        {(Object.keys(bySide) as PortSide[]).map((sd) =>
          bySide[sd].map((p, i) => (
            <PhysicalPort
              key={p.id}
              port={p}
              side={sd}
              frac={fracOf(p, i, bySide[sd].length)}
              boxRef={boxRef}
              onCycle={onCycle}
              onDragPreview={(portId, placement) => setPreview({ portId, placement })}
              onDragCommit={(port, placement) => {
                setPreview(null);
                if (placement) setPortPlacement(element.id, port.id, placement.side, placement.frac);
              }}
            />
          )),
        )}
        <div
          className={`pointer-events-none absolute left-1/2 top-full mt-1 w-[120px] -translate-x-1/2 text-center text-[10px] leading-tight
            ${selected ? "font-semibold text-[color:var(--ss-accent)]" : "text-[color:var(--ss-node-icon)]"}`}
        >
          {element.label}
        </div>
      </div>
    </>
  );
});

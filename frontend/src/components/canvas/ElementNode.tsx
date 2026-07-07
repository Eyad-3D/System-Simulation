import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { ComponentDef, ElementInstance, PortDef, PortSide } from "../../types";
import { useProjectStore } from "../../store/projectStore";
import { componentIcon } from "../../icons";

export type ElementNodeData = {
  element: ElementInstance;
  def: ComponentDef;
};

export type ElementFlowNode = Node<ElementNodeData, "element">;

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

function handleClass(kind: PortDef["kind"]): string {
  return `ss-handle-${kind}`;
}

/** A physical (non-signal) port: one interactive source handle that can both
 *  start and end connections, plus an invisible target handle underneath so
 *  incoming edges have an anchor of type 'target' at the same spot.
 *  Shift+click moves the pin to the next side of the node. */
function PhysicalPort({
  port,
  side,
  index,
  count,
  onCycle,
}: {
  port: PortDef;
  side: PortSide;
  index: number;
  count: number;
  onCycle: (port: PortDef, next: PortSide) => void;
}) {
  const pos = POSITION_OF[side];
  const offset = `${((index + 1) * 100) / (count + 1)}%`;
  const style =
    side === "top" || side === "bottom" ? { left: offset } : { top: offset };
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
        style={style}
        className={handleClass(port.kind)}
        isConnectableStart
        isConnectableEnd
        title={`${port.name} (${port.kind}) — Shift+click to move the pin`}
        onClick={(e) => {
          if (e.shiftKey) {
            e.stopPropagation();
            e.preventDefault();
            onCycle(port, NEXT_SIDE[side]);
          }
        }}
      />
    </>
  );
}

export const ElementNode = memo(({ data, selected }: NodeProps<ElementFlowNode>) => {
  const { def, element } = data;
  const Icon = componentIcon(def.icon);
  const setPortSide = useProjectStore((s) => s.setPortSide);

  // physical ports only — signal / data-bus wiring is managed in the
  // Data Bus Connections panel and is not drawn on the canvas
  const physical = def.ports.filter((p) => p.kind !== "signal");
  const sideOf = (p: PortDef): PortSide =>
    element.portSides?.[p.id] ?? ((p.side as PortSide) || "left");
  const bySide: Record<PortSide, PortDef[]> = { left: [], right: [], top: [], bottom: [] };
  for (const p of physical) bySide[sideOf(p)].push(p);

  const onCycle = (port: PortDef, next: PortSide) =>
    setPortSide(element.id, port.id, next);

  const portRows = Math.max(bySide.left.length, bySide.right.length, 1);
  const height = Math.max(54, portRows * 18 + 18);
  const isSub = element.isSubSystem;

  return (
    <div className="group relative" style={{ width: 92 }}>
      <div
        className={`relative mx-auto flex items-center justify-center rounded-md border bg-[color:var(--ss-panel)] shadow-sm transition-shadow
          ${isSub ? "border-dashed border-[color:var(--ss-accent)] bg-[color:var(--ss-accent-soft)]" : "border-[color:var(--ss-node-border)]"}
          ${selected ? "outline outline-2 outline-[color:var(--ss-accent)] shadow-md" : ""}`}
        style={{ width: 92, height }}
        title={isSub ? "Double-click to open sub-system" : `${def.name} — double-click for parameters`}
      >
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
        {(Object.keys(bySide) as PortSide[]).map((side) =>
          bySide[side].map((p, i) => (
            <PhysicalPort
              key={p.id}
              port={p}
              side={side}
              index={i}
              count={bySide[side].length}
              onCycle={onCycle}
            />
          )),
        )}
      </div>
      <div
        className={`pointer-events-none mt-1 w-full text-center text-[10px] leading-tight
          ${selected ? "font-semibold text-[color:var(--ss-accent)]" : "text-[color:var(--ss-node-icon)]"}`}
      >
        {element.label}
      </div>
    </div>
  );
});

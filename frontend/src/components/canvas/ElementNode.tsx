import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { ComponentDef, ElementInstance, PortDef } from "../../types";
import { componentIcon } from "../../icons";

export type ElementNodeData = {
  element: ElementInstance;
  def: ComponentDef;
};

export type ElementFlowNode = Node<ElementNodeData, "element">;

function handleClass(kind: PortDef["kind"]): string {
  return `ss-handle-${kind}`;
}

/** A physical (non-signal) port: one interactive source handle that can both
 *  start and end connections, plus an invisible target handle underneath so
 *  incoming edges have an anchor of type 'target' at the same spot. */
function PhysicalPort({ port, index, count }: { port: PortDef; index: number; count: number }) {
  const side = port.side === "right" ? Position.Right : Position.Left;
  const top = `${((index + 1) * 100) / (count + 1)}%`;
  return (
    <>
      <Handle
        id={port.id}
        type="target"
        position={side}
        style={{ top, pointerEvents: "none", opacity: 0 }}
        isConnectableStart={false}
      />
      <Handle
        id={port.id}
        type="source"
        position={side}
        style={{ top }}
        className={handleClass(port.kind)}
        isConnectableStart
        isConnectableEnd
        title={`${port.name} (${port.kind})`}
      />
    </>
  );
}

function SignalPort({
  port,
  index,
  count,
  role,
}: {
  port: PortDef;
  index: number;
  count: number;
  role: "input" | "output";
}) {
  const left = `${((index + 1) * 100) / (count + 1)}%`;
  if (role === "input") {
    return (
      <Handle
        id={port.id}
        type="target"
        position={Position.Top}
        style={{ left }}
        className={handleClass("signal")}
        isConnectableStart={false}
        title={`${port.name} (signal in)`}
      />
    );
  }
  return (
    <Handle
      id={port.id}
      type="source"
      position={Position.Bottom}
      style={{ left }}
      className={handleClass("signal")}
      isConnectableEnd={false}
      title={`${port.name} (signal out)`}
    />
  );
}

export const ElementNode = memo(({ data, selected }: NodeProps<ElementFlowNode>) => {
  const { def, element } = data;
  const Icon = componentIcon(def.icon);

  const left = def.ports.filter((p) => p.kind !== "signal" && p.side !== "right");
  const right = def.ports.filter((p) => p.kind !== "signal" && p.side === "right");
  const sigIn = def.ports.filter((p) => p.kind === "signal" && p.direction === "input");
  // only signal-domain sources expose their outputs on the canvas;
  // other computed signals are wired via the Data Bus panel
  const sigOut =
    def.domain === "signal"
      ? def.ports.filter((p) => p.kind === "signal" && p.direction === "output")
      : [];

  const portRows = Math.max(left.length, right.length, 1);
  const height = Math.max(54, portRows * 18 + 18);
  const isSub = element.isSubSystem;

  return (
    <div className="group relative" style={{ width: 92 }}>
      <div
        className={`relative mx-auto flex items-center justify-center rounded-md border bg-white shadow-sm transition-shadow
          ${isSub ? "border-dashed border-[color:var(--ss-accent)] bg-[#f4f8fc]" : "border-[#8b94a3]"}
          ${selected ? "outline outline-2 outline-[color:var(--ss-accent)] shadow-md" : ""}`}
        style={{ width: 92, height }}
        title={isSub ? "Double-click to open sub-system" : def.name}
      >
        <Icon
          size={isSub ? 26 : 30}
          strokeWidth={1.5}
          className={isSub ? "text-[color:var(--ss-accent)]" : "text-[#3c4654]"}
        />
        {isSub && (
          <span className="absolute bottom-0.5 right-1 text-[8px] font-semibold uppercase tracking-wide text-[color:var(--ss-accent)]">
            SYS
          </span>
        )}
        {left.map((p, i) => (
          <PhysicalPort key={p.id} port={p} index={i} count={left.length} />
        ))}
        {right.map((p, i) => (
          <PhysicalPort key={p.id} port={p} index={i} count={right.length} />
        ))}
        {sigIn.map((p, i) => (
          <SignalPort key={p.id} port={p} index={i} count={sigIn.length} role="input" />
        ))}
        {sigOut.map((p, i) => (
          <SignalPort key={p.id} port={p} index={i} count={sigOut.length} role="output" />
        ))}
      </div>
      <div
        className={`pointer-events-none mt-1 w-full text-center text-[10px] leading-tight
          ${selected ? "font-semibold text-[color:var(--ss-accent)]" : "text-[#3c4654]"}`}
      >
        {element.label}
      </div>
    </div>
  );
});

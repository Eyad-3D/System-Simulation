// Shared data model — mirrors the backend pydantic schemas (spec §4).

export type ScalarValue = number | string | boolean;
// Tabular parameter data keyed by the independent variable (numeric text keys).
export type Table1D = Record<string, number>;
export type Table2D = Record<string, Record<string, number>>;
export type ParamValue = ScalarValue | Table1D | Table2D;

export type PortKind =
  | "power"
  | "signal"
  | "mechanical"
  | "electrical"
  | "thermal"
  | "fluid";

export type Domain = "mechanical" | "electrical" | "thermal" | "signal" | "fluid";

export interface PortDef {
  id: string;
  name: string;
  direction: "input" | "output" | "bidirectional";
  kind: PortKind;
  unitGroup?: string;
  side?: "left" | "right"; // canvas layout hint
}

export interface AxisDef {
  name: string;
  unit: string;
}

export interface ParameterDef {
  key: string;
  label: string;
  /** Required; "-" marks dimensionless. For tables: unit of the dependent value. */
  unit: string;
  default: ParamValue;
  type: "number" | "enum" | "boolean" | "string" | "code" | "table1d" | "table2d";
  options?: string[];
  /** table1d: one axis; table2d: [outer, inner]. */
  axes?: AxisDef[];
}

export interface ComponentDef {
  id: string;
  category: string;
  name: string;
  icon: string;
  domain: Domain;
  description?: string;
  ports: PortDef[];
  parameters: ParameterDef[];
  /** Elements of this type may carry per-instance signal ports (Script, Monitor). */
  allowDynamicPorts?: boolean;
}

export type PortSide = "left" | "right" | "top" | "bottom";

export interface ElementInstance {
  id: string;
  componentDefId: string;
  label: string;
  position: { x: number; y: number };
  parameterOverrides: Record<string, ParamValue>;
  /** Per-instance signal ports; only honored when the def allows them. */
  dynamicPorts?: PortDef[];
  /** Per-instance canvas pin placement (Shift+click a pin to move it). */
  portSides?: Record<string, PortSide>;
  isSubSystem?: boolean;
  subSystemId?: string | null;
}

export interface Connection {
  id: string;
  sourceElementId: string;
  sourcePortId: string;
  targetElementId: string;
  targetPortId: string;
}

export interface DataBusConnection {
  id: string;
  element1Id: string;
  port1Id: string;
  element2Id: string;
  port2Id: string;
}

export interface SystemNode {
  id: string;
  name: string;
  parentId: string | null;
  elements: ElementInstance[];
  connections: Connection[];
}

export interface SimCase {
  id: string;
  name: string;
  duration: number;
  /** Recording interval in seconds; the solver sub-steps internally. */
  timeStep: number;
  /** 0 = as fast as possible; N > 0 = pace at N× real time (live tuning). */
  realtimeFactor?: number;
}

export interface Project {
  id: string;
  name: string;
  systems: SystemNode[];
  dataBusConnections: DataBusConnection[];
  cases: SimCase[];
}

export interface SimMessage {
  level: "info" | "warning" | "error";
  text: string;
}

export interface Channel {
  elementId: string;
  portId: string;
  label: string;
  unit: string;
  timeSeries: { t: number; value: number }[];
}

export interface SummaryValue {
  label: string;
  value: number;
  unit: string;
}

export interface SimResult {
  caseId: string;
  status: "success" | "failed" | "warning";
  messages: SimMessage[];
  channels: Channel[];
  summary: SummaryValue[];
}

export interface DataCheck {
  level: "info" | "warning" | "error";
  elementId?: string | null;
  elementLabel?: string | null;
  text: string;
}

export interface LogMessage {
  level: "info" | "warning" | "error";
  text: string;
  time: string; // HH:MM:SS
}

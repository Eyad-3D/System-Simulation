"""Pydantic models mirroring the SimStudio project data model (spec §4).

Field names use camelCase to match the frontend/JSON representation 1:1.
"""
from __future__ import annotations

from typing import Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

ParamValue = Union[float, int, str, bool]


class PortDef(BaseModel):
    id: str
    name: str
    direction: Literal["input", "output", "bidirectional"]
    kind: Literal["power", "signal", "mechanical", "electrical", "thermal", "fluid"]
    unitGroup: Optional[str] = None


class ParameterDef(BaseModel):
    key: str
    label: str
    unit: Optional[str] = None
    default: ParamValue
    type: Literal["number", "enum", "boolean", "string"]
    options: Optional[list[str]] = None


class ComponentDef(BaseModel):
    id: str
    category: str
    name: str
    icon: str
    domain: Literal["mechanical", "electrical", "thermal", "signal", "fluid"]
    description: Optional[str] = None
    ports: list[PortDef]
    parameters: list[ParameterDef]


class ElementInstance(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    componentDefId: str
    label: str
    position: dict[str, float]
    parameterOverrides: dict[str, ParamValue] = Field(default_factory=dict)
    isSubSystem: bool = False
    subSystemId: Optional[str] = None  # SystemNode this element drills into


class Connection(BaseModel):
    id: str
    sourceElementId: str
    sourcePortId: str
    targetElementId: str
    targetPortId: str


class DataBusConnection(BaseModel):
    id: str
    element1Id: str
    port1Id: str
    element2Id: str
    port2Id: str


class SystemNode(BaseModel):
    id: str
    name: str
    parentId: Optional[str] = None
    elements: list[ElementInstance] = Field(default_factory=list)
    connections: list[Connection] = Field(default_factory=list)


class SimCase(BaseModel):
    id: str
    name: str
    duration: float = 600.0
    timeStep: float = 1.0


class Project(BaseModel):
    id: str
    name: str
    systems: list[SystemNode]
    dataBusConnections: list[DataBusConnection] = Field(default_factory=list)
    cases: list[SimCase] = Field(default_factory=list)


class SimMessage(BaseModel):
    level: Literal["info", "warning", "error"]
    text: str


class Channel(BaseModel):
    elementId: str
    portId: str
    label: str
    unit: str
    timeSeries: list[dict[str, float]]  # {t, value}


class SummaryValue(BaseModel):
    label: str
    value: float
    unit: str


class SimResult(BaseModel):
    caseId: str
    status: Literal["success", "failed", "warning"]
    messages: list[SimMessage]
    channels: list[Channel]
    summary: list[SummaryValue] = Field(default_factory=list)


class DataCheck(BaseModel):
    level: Literal["info", "warning", "error"]
    elementId: Optional[str] = None
    elementLabel: Optional[str] = None
    text: str


class SimulateRequest(BaseModel):
    project: Project
    caseId: str


class ValidateRequest(BaseModel):
    project: Project

"""Data Checks — pre-run model validation (spec §7.5)."""
from __future__ import annotations

from .library import library_by_id
from .schemas import DataCheck, Project
from .solver import LOAD_TYPES, SOURCE_TYPES, build_context

NUMERIC_RANGES: dict[str, tuple[str, float, float]] = {
    # param key → (label, min exclusive?, max)
    "efficiency_pct": ("Efficiency", 0.0, 100.0),
    "prop_efficiency_pct": ("Propulsive efficiency", 0.0, 100.0),
    "initial_soc_pct": ("Initial SOC", 0.0, 100.0),
    "min_soc_pct": ("Minimum SOC", 0.0, 100.0),
}


def validate_project(project: Project) -> list[DataCheck]:
    checks: list[DataCheck] = []
    defs = library_by_id()

    def add(level: str, text: str, el=None) -> None:
        checks.append(DataCheck(
            level=level,  # type: ignore[arg-type]
            text=text,
            elementId=el.id if el else None,
            elementLabel=el.label if el else None,
        ))

    all_elements = {el.id: el for s in project.systems for el in s.elements}

    # -- reference integrity ---------------------------------------------------
    for el in all_elements.values():
        if el.componentDefId not in defs:
            add("error", f"Element references unknown component type '{el.componentDefId}'.", el)

    def port_of(el_id: str, port_id: str):
        el = all_elements.get(el_id)
        if el is None:
            return None
        cdef = defs.get(el.componentDefId)
        if cdef is None:
            return None
        return next((p for p in cdef.ports if p.id == port_id), None)

    for system in project.systems:
        for conn in system.connections:
            for el_id, port_id in ((conn.sourceElementId, conn.sourcePortId),
                                   (conn.targetElementId, conn.targetPortId)):
                if el_id not in all_elements:
                    add("error", f"Connection '{conn.id}' references missing element '{el_id}'.")
                elif port_of(el_id, port_id) is None:
                    add("error",
                        f"Connection '{conn.id}' references missing port '{port_id}' "
                        f"on '{all_elements[el_id].label}'.")
            pa = port_of(conn.sourceElementId, conn.sourcePortId)
            pb = port_of(conn.targetElementId, conn.targetPortId)
            if pa and pb and pa.kind != pb.kind and "signal" not in (pa.kind, pb.kind):
                add("error",
                    f"Connection between '{all_elements[conn.sourceElementId].label}' and "
                    f"'{all_elements[conn.targetElementId].label}' mixes incompatible port "
                    f"kinds ({pa.kind} ↔ {pb.kind}).")

    for dbc in project.dataBusConnections:
        p1 = port_of(dbc.element1Id, dbc.port1Id)
        p2 = port_of(dbc.element2Id, dbc.port2Id)
        if p1 is None or p2 is None:
            add("error", "Data bus connection references a missing element or port.")
            continue
        if p1.direction == "output" and p2.direction == "output":
            add("warning",
                f"Data bus connection links two outputs "
                f"('{all_elements[dbc.element1Id].label}.{p1.name}' ↔ "
                f"'{all_elements[dbc.element2Id].label}.{p2.name}') — no data will flow.")
        if p1.direction == "input" and p2.direction == "input":
            add("warning",
                f"Data bus connection links two inputs "
                f"('{all_elements[dbc.element1Id].label}.{p1.name}' ↔ "
                f"'{all_elements[dbc.element2Id].label}.{p2.name}') — no data will flow.")

    # -- parameter sanity --------------------------------------------------------
    ctx = build_context(project)
    for el_id, cdef in ctx.cdef_of.items():
        el = all_elements[el_id]
        params = ctx.params_of[el_id]
        for key, (label, lo, hi) in NUMERIC_RANGES.items():
            if key in params:
                try:
                    v = float(params[key])
                except (TypeError, ValueError):
                    add("error", f"{label} of '{el.label}' is not a number.", el)
                    continue
                if not (lo < v <= hi):
                    add("error", f"{label} of '{el.label}' must be in ({lo:g}, {hi:g}] — got {v:g}.", el)
        if cdef.id == "battery.generic" and float(params.get("capacity_kWh", 0)) <= 0:
            add("error", f"Battery '{el.label}' has a non-positive capacity.", el)

    # -- topology-level checks -----------------------------------------------------
    loads = [el_id for el_id, cdef in ctx.cdef_of.items() if cdef.id in LOAD_TYPES]
    sources = [el_id for el_id, cdef in ctx.cdef_of.items() if cdef.id in SOURCE_TYPES]

    if not loads:
        add("warning", "Model contains no load element (Propeller, Wheel, Constant Drive) — a run would fail.")
    if loads and not sources:
        add("error", "Model has loads but no power source (Battery or Voltage Source).")

    # reachability: every load must reach a source over power connections
    def reaches_source(el_id: str) -> bool:
        seen: set[str] = set()
        stack = [el_id]
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            cdef = ctx.cdef_of.get(cur)
            if cdef and cdef.id in SOURCE_TYPES:
                return True
            for (a_el, _a_port), peers in ctx.adjacency.items():
                if a_el != cur:
                    continue
                for (b_el, _b_port) in peers:
                    if b_el not in seen:
                        stack.append(b_el)
        return False

    for el_id in loads:
        el = all_elements[el_id]
        cdef = ctx.cdef_of[el_id]
        main_port = "terminal" if cdef.id == "electric.constant_drive" else "shaft"
        if not ctx.adjacency.get((el_id, main_port)):
            add("error", f"Required port '{main_port}' of '{el.label}' is not connected.", el)
        elif not reaches_source(el_id):
            add("error", f"No power source is reachable from load '{el.label}'.", el)

    # demand signals
    for el_id in loads:
        el = all_elements[el_id]
        cdef = ctx.cdef_of[el_id]
        if cdef.id == "propulsion.propeller" and (el_id, "sig_demand_in") not in ctx.signal_route:
            add("info",
                f"Propeller '{el.label}' has no 'Power demand' data-bus signal — "
                f"the fallback constant demand parameter will be used.", el)
        if cdef.id == "propulsion.wheel" and (el_id, "sig_speed_in") not in ctx.signal_route:
            add("warning",
                f"Wheel '{el.label}' has no 'Vehicle speed' signal — traction power will be zero.", el)

    # motors without electrical supply
    for el_id, cdef in ctx.cdef_of.items():
        if cdef.id == "motor.emotor":
            el = all_elements[el_id]
            if not ctx.adjacency.get((el_id, "terminal")):
                add("error", f"E-Motor '{el.label}' has no electrical connection.", el)
            if not ctx.adjacency.get((el_id, "shaft")):
                add("warning", f"E-Motor '{el.label}' has no mechanical connection — it will idle.", el)

    if not any(s.elements for s in project.systems):
        add("info", "Model is empty — drag components from the library onto the canvas.")
    if not project.cases:
        add("warning", "Project has no simulation case defined.")

    if not checks:
        add("info", "All data checks passed — model is ready to run.")
    return checks

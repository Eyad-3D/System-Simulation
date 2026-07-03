"""SimStudio v1 solver.

Quasi-static, fixed-step solver (spec §7). Intentionally simplified physics:
at every timestep the demand of each *load* element (propeller, wheel,
constant drive) is propagated backward through the topology
(shaft → motor → DC-DC → node → battery), applying each component's
flat efficiency. Battery SOC is integrated forward. Signals (driving task,
constants, computed outputs) travel over Data Bus connections or
signal-kind canvas connections.

This is a believable demo solver, not a physically rigorous one.
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field

from .library import library_by_id
from .schemas import (
    Channel,
    ComponentDef,
    ElementInstance,
    Project,
    SimMessage,
    SimResult,
    SummaryValue,
)

GRAVITY = 9.81
AIR_DENSITY = 1.2

UNIT_BY_GROUP = {
    "Power": "kW",
    "Voltage": "V",
    "Current": "A",
    "Velocity": "km/h",
    "Temperature": "°C",
    "Torque": "Nm",
    "No Unit": "-",
}

LOAD_TYPES = {"propulsion.propeller", "propulsion.wheel", "electric.constant_drive"}
SOURCE_TYPES = {"battery.generic", "electric.voltage_source"}


def resolve_params(el: ElementInstance, cdef: ComponentDef) -> dict:
    params = {p.key: p.default for p in cdef.parameters}
    params.update(el.parameterOverrides)
    return params


def parse_profile(profile: str) -> list[tuple[float, float]]:
    """Parse 't:value; t:value; …' (also accepts ',' as pair separator)."""
    points: list[tuple[float, float]] = []
    for chunk in profile.replace("\n", ";").split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        sep = ":" if ":" in chunk else ","
        try:
            t_str, v_str = chunk.split(sep, 1)
            points.append((float(t_str), float(v_str)))
        except ValueError:
            continue
    points.sort(key=lambda p: p[0])
    return points


def interp_profile(points: list[tuple[float, float]], t: float, repeat: bool) -> float:
    if not points:
        return 0.0
    t0, tn = points[0][0], points[-1][0]
    if repeat and tn > t0:
        t = t0 + (t - t0) % (tn - t0)
    if t <= t0:
        return points[0][1]
    if t >= tn:
        return points[-1][1]
    for (ta, va), (tb, vb) in zip(points, points[1:]):
        if ta <= t <= tb:
            if tb == ta:
                return vb
            return va + (vb - va) * (t - ta) / (tb - ta)
    return points[-1][1]


@dataclass
class BatteryState:
    soc: float  # 0..1
    capacity_kwh: float
    nominal_v: float
    resistance: float
    min_soc: float
    depleted_flagged: bool = False
    energy_out_kwh: float = 0.0
    loss_kwh: float = 0.0
    # per-step accumulators
    draw_kw: float = 0.0

    def open_circuit_voltage(self) -> float:
        # linear OCV(SOC): 85 % … 115 % of nominal
        return self.nominal_v * (0.85 + 0.30 * max(0.0, min(1.0, self.soc)))


@dataclass
class SolveContext:
    elements: dict[str, ElementInstance]
    defs: dict[str, ComponentDef]
    cdef_of: dict[str, ComponentDef]  # element id → component def
    params_of: dict[str, dict]
    adjacency: dict[tuple[str, str], list[tuple[str, str]]]
    signal_route: dict[tuple[str, str], tuple[str, str]]  # input → output port
    messages: list[SimMessage] = field(default_factory=list)
    warned: set[str] = field(default_factory=set)

    def warn_once(self, key: str, text: str, level: str = "warning") -> None:
        if key not in self.warned:
            self.warned.add(key)
            self.messages.append(SimMessage(level=level, text=text))


def build_context(project: Project) -> SolveContext:
    defs = library_by_id()
    elements: dict[str, ElementInstance] = {}
    adjacency: dict[tuple[str, str], list[tuple[str, str]]] = defaultdict(list)
    signal_route: dict[tuple[str, str], tuple[str, str]] = {}

    for system in project.systems:
        for el in system.elements:
            elements[el.id] = el

    cdef_of = {
        el_id: defs[el.componentDefId]
        for el_id, el in elements.items()
        if el.componentDefId in defs
    }
    params_of = {
        el_id: resolve_params(elements[el_id], cdef_of[el_id])
        for el_id in cdef_of
    }

    def port_def(el_id: str, port_id: str):
        cdef = cdef_of.get(el_id)
        if not cdef:
            return None
        return next((p for p in cdef.ports if p.id == port_id), None)

    def add_link(a: tuple[str, str], b: tuple[str, str]) -> None:
        pa, pb = port_def(*a), port_def(*b)
        if pa is None or pb is None:
            return
        if pa.kind == "signal" or pb.kind == "signal":
            # signal link: map the input side to the output side
            if pa.direction == "output" and pb.direction != "output":
                signal_route[b] = a
            elif pb.direction == "output" and pa.direction != "output":
                signal_route[a] = b
            return
        adjacency[a].append(b)
        adjacency[b].append(a)

    for system in project.systems:
        for conn in system.connections:
            add_link(
                (conn.sourceElementId, conn.sourcePortId),
                (conn.targetElementId, conn.targetPortId),
            )
    for dbc in project.dataBusConnections:
        add_link((dbc.element1Id, dbc.port1Id), (dbc.element2Id, dbc.port2Id))

    return SolveContext(
        elements=elements,
        defs=defs,
        cdef_of=cdef_of,
        params_of=params_of,
        adjacency=dict(adjacency),
        signal_route=signal_route,
    )


def simulate(project: Project, case_id: str) -> SimResult:
    case = next((c for c in project.cases if c.id == case_id), None)
    if case is None:
        return SimResult(
            caseId=case_id,
            status="failed",
            messages=[SimMessage(level="error", text=f"Simulation case '{case_id}' not found.")],
            channels=[],
        )

    ctx = build_context(project)
    dt = max(0.01, case.timeStep)
    steps = max(1, int(round(case.duration / dt)))

    # --- battery states -----------------------------------------------------
    batteries: dict[str, BatteryState] = {}
    for el_id, cdef in ctx.cdef_of.items():
        if cdef.id == "battery.generic":
            p = ctx.params_of[el_id]
            batteries[el_id] = BatteryState(
                soc=float(p.get("initial_soc_pct", 90)) / 100.0,
                capacity_kwh=float(p.get("capacity_kWh", 120)),
                nominal_v=float(p.get("nominal_voltage_V", 400)),
                resistance=float(p.get("internal_resistance_ohm", 0.05)),
                min_soc=float(p.get("min_soc_pct", 10)) / 100.0,
            )

    loads = [el_id for el_id, cdef in ctx.cdef_of.items() if cdef.id in LOAD_TYPES]
    if not loads:
        ctx.messages.append(SimMessage(
            level="error",
            text="No load elements (Propeller, Wheel or Constant Drive) in the model — nothing to solve.",
        ))
        return SimResult(caseId=case_id, status="failed", messages=ctx.messages, channels=[])

    # recorded time series: (element, port) → list of values
    series: dict[tuple[str, str], list[float]] = defaultdict(list)
    times: list[float] = []
    signal_values: dict[tuple[str, str], float] = {}
    vs_energy_kwh: dict[str, float] = defaultdict(float)

    # --- per-step accumulators (reset each step) ----------------------------
    step_acc: dict[tuple[str, str], float] = {}

    def acc(el_id: str, port_id: str, value: float) -> None:
        step_acc[(el_id, port_id)] = step_acc.get((el_id, port_id), 0.0) + value

    # --- power pull (backward propagation) ----------------------------------
    NODE_PORTS = ("t1", "t2", "t3", "t4", "t5")

    def can_supply(el_id: str, port_id: str, seen: frozenset) -> bool:
        """Direction-aware reachability: can a power source be reached when
        entering element el_id at port_id while looking for supply?"""
        key = (el_id, port_id)
        if key in seen:
            return False
        seen = seen | {key}
        cdef = ctx.cdef_of.get(el_id)
        if cdef is None:
            return False
        t = cdef.id

        def probe(exit_port: str) -> bool:
            nxt = seen | {(el_id, exit_port)}
            return any(
                can_supply(pe, pp, nxt)
                for pe, pp in ctx.adjacency.get((el_id, exit_port), [])
            )

        if t in SOURCE_TYPES:
            return True
        if t == "electric.node":
            return any(probe(pid) for pid in NODE_PORTS if pid != port_id)
        if t == "controller.dcdc":
            # v1: unidirectional — supplies at terminal B, draws at terminal A
            return port_id == "terminal_b" and probe("terminal_a")
        if t == "mech.shaft":
            return probe("flange_a" if port_id == "flange_b" else "flange_b")
        if t == "motor.emotor":
            # supplies mechanical power at the shaft, drawing electrically
            return port_id == "shaft" and probe("terminal")
        return False

    def forward(el_id: str, port_id: str, p_kw: float, visited: set) -> None:
        """Push a demand of p_kw out of (el_id, port_id) toward supply."""
        peers = [
            pr for pr in ctx.adjacency.get((el_id, port_id), [])
            if pr not in visited and can_supply(pr[0], pr[1], frozenset(visited) | {(el_id, port_id)})
        ]
        if not peers:
            el = ctx.elements[el_id]
            ctx.warn_once(
                f"open:{el_id}:{port_id}",
                f"'{el.label}' has no supply path at port '{port_id}' — demand is dropped.",
            )
            return
        share = p_kw / len(peers)
        for peer in peers:
            pull(peer[0], peer[1], share, visited)

    def pull(el_id: str, port_id: str, p_kw: float, visited: set) -> None:
        """Request p_kw from element el_id, entering at port_id."""
        if p_kw <= 0:
            return
        key = (el_id, port_id)
        if key in visited:
            return
        visited.add(key)
        cdef = ctx.cdef_of.get(el_id)
        if cdef is None:
            return
        el = ctx.elements[el_id]
        p = ctx.params_of[el_id]
        t = cdef.id

        if t == "battery.generic":
            batteries[el_id].draw_kw += p_kw
        elif t == "electric.voltage_source":
            acc(el_id, "sig_power", p_kw)
            vs_energy_kwh[el_id] += p_kw * dt / 3600.0
        elif t == "controller.dcdc":
            if port_id != "terminal_b":
                ctx.warn_once(
                    f"dcdc-dir:{el_id}",
                    f"DC-DC '{el.label}' can only supply power at Terminal B (v1 is unidirectional).",
                )
                return
            eff = max(1e-3, float(p.get("efficiency_pct", 97)) / 100.0)
            p_in = p_kw / eff
            acc(el_id, "sig_power_out", p_kw)
            acc(el_id, "sig_power_in", p_in)
            acc(el_id, "sig_losses", p_in - p_kw)
            forward(el_id, "terminal_a", p_in, visited)
        elif t == "electric.node":
            acc(el_id, "sig_power", p_kw)
            live = [
                pid for pid in NODE_PORTS
                if pid != port_id and any(
                    pr not in visited and can_supply(pr[0], pr[1], frozenset(visited) | {(el_id, pid)})
                    for pr in ctx.adjacency.get((el_id, pid), [])
                )
            ]
            if not live:
                ctx.warn_once(
                    f"node-dead:{el_id}",
                    f"Electric node '{el.label}' has no upstream supply to satisfy demand.",
                )
                return
            share = p_kw / len(live)
            for pid in live:
                forward(el_id, pid, share, visited)
        elif t == "mech.shaft":
            eff = max(1e-3, float(p.get("efficiency_pct", 100)) / 100.0)
            p_in = p_kw / eff
            acc(el_id, "sig_power", p_kw)
            other = "flange_a" if port_id == "flange_b" else "flange_b"
            forward(el_id, other, p_in, visited)
        elif t == "motor.emotor":
            eff = max(1e-3, float(p.get("efficiency_pct", 94)) / 100.0)
            p_max = float(p.get("max_power_kW", 150))
            p_mech = p_kw
            if p_mech > p_max:
                ctx.warn_once(
                    f"motor-limit:{el_id}",
                    f"E-Motor '{el.label}' demand {p_mech:.1f} kW exceeds its maximum "
                    f"power ({p_max:.1f} kW) — output clamped.",
                )
                p_mech = p_max
            p_elec = p_mech / eff
            acc(el_id, "sig_mech_power", p_mech)
            acc(el_id, "sig_elec_power", p_elec)
            acc(el_id, "sig_losses", p_elec - p_mech)
            forward(el_id, "terminal", p_elec, visited)
        elif t == "boundary.ground":
            pass  # ground sinks nothing
        else:
            ctx.warn_once(
                f"nosupply:{el_id}",
                f"'{el.label}' ({cdef.name}) cannot supply power — demand is dropped.",
            )

    # --- main time loop ------------------------------------------------------
    for step in range(steps + 1):
        t = step * dt
        times.append(t)
        step_acc.clear()
        for b in batteries.values():
            b.draw_kw = 0.0

        # 1. evaluate signal sources
        for el_id, cdef in ctx.cdef_of.items():
            p = ctx.params_of[el_id]
            if cdef.id == "signal.constant":
                signal_values[(el_id, "sig_out")] = float(p.get("value", 0))
                acc(el_id, "sig_out", float(p.get("value", 0)))
            elif cdef.id == "signal.driving_task":
                pts = parse_profile(str(p.get("profile", "")))
                scale = float(p.get("scale_pct", 100)) / 100.0
                val = interp_profile(pts, t, bool(p.get("repeat", False))) * scale
                signal_values[(el_id, "sig_demand")] = val
                acc(el_id, "sig_demand", val)

        def read_signal(el_id: str, input_port: str) -> float | None:
            src = ctx.signal_route.get((el_id, input_port))
            if src is None:
                return None
            return signal_values.get(src)

        # 2. loads compute their demand and pull it backward through the graph
        for el_id in loads:
            cdef = ctx.cdef_of[el_id]
            el = ctx.elements[el_id]
            p = ctx.params_of[el_id]
            visited: set = set()

            if cdef.id == "propulsion.propeller":
                demand = read_signal(el_id, "sig_demand_in")
                if demand is None:
                    demand = float(p.get("power_demand_kW", 0))
                    ctx.warn_once(
                        f"prop-fallback:{el_id}",
                        f"Propeller '{el.label}' has no 'Power demand' signal — "
                        f"using fallback constant of {demand:.0f} kW.",
                        level="info",
                    )
                demand = max(0.0, demand)
                eff = max(1e-3, float(p.get("prop_efficiency_pct", 80)) / 100.0)
                shaft_power = demand / eff
                acc(el_id, "sig_thrust_power", demand)
                acc(el_id, "sig_shaft_power", shaft_power)
                visited.add((el_id, "shaft"))
                forward(el_id, "shaft", shaft_power, visited)
            elif cdef.id == "propulsion.wheel":
                v_kmh = read_signal(el_id, "sig_speed_in") or 0.0
                v = max(0.0, v_kmh) / 3.6
                mass = float(p.get("vehicle_mass_kg", 1500))
                crr = float(p.get("rolling_resistance", 0.012))
                cda = float(p.get("cda_m2", 0.6))
                force = mass * GRAVITY * crr + 0.5 * AIR_DENSITY * cda * v * v
                power = force * v / 1000.0
                acc(el_id, "sig_traction_power", power)
                visited.add((el_id, "shaft"))
                forward(el_id, "shaft", power, visited)
            elif cdef.id == "electric.constant_drive":
                demand = read_signal(el_id, "sig_demand_in")
                if demand is None:
                    demand = float(p.get("power_kW", 0))
                demand = max(0.0, demand)
                acc(el_id, "sig_power", demand)
                visited.add((el_id, "terminal"))
                forward(el_id, "terminal", demand, visited)

        # 3. update batteries and publish their signals
        for el_id, b in batteries.items():
            v_oc = b.open_circuit_voltage()
            p_w = b.draw_kw * 1000.0
            depleted = b.soc <= b.min_soc
            if depleted and p_w > 0:
                if not b.depleted_flagged:
                    b.depleted_flagged = True
                    ctx.messages.append(SimMessage(
                        level="warning",
                        text=f"Battery '{ctx.elements[el_id].label}' reached minimum SOC "
                             f"({b.min_soc * 100:.0f} %) at t = {t:.0f} s — no further discharge.",
                    ))
                p_w = 0.0
            disc = v_oc * v_oc - 4.0 * b.resistance * p_w
            if disc < 0:
                # demand beyond max deliverable power — clamp at max power point
                ctx.warn_once(
                    f"bat-maxp:{el_id}",
                    f"Battery '{ctx.elements[el_id].label}' demand exceeds its deliverable "
                    f"power — clamped at the maximum power point.",
                )
                current = v_oc / (2.0 * b.resistance)
                p_w = v_oc * v_oc / (4.0 * b.resistance)
            else:
                current = (v_oc - math.sqrt(disc)) / (2.0 * b.resistance) if b.resistance > 0 else p_w / v_oc
            v_term = v_oc - current * b.resistance
            loss_w = current * current * b.resistance
            if step < steps:  # integrate over dt (skip after the last sample)
                e_kwh = (p_w + loss_w) * dt / 3600.0 / 1000.0
                b.soc = max(0.0, b.soc - e_kwh / b.capacity_kwh) if b.capacity_kwh > 0 else 0.0
                b.energy_out_kwh += p_w * dt / 3600.0 / 1000.0
                b.loss_kwh += loss_w * dt / 3600.0 / 1000.0
            acc(el_id, "sig_soc", b.soc * 100.0)
            acc(el_id, "sig_voltage", v_term)
            acc(el_id, "sig_current", current)
            acc(el_id, "sig_power", p_w / 1000.0)
            signal_values[(el_id, "sig_soc")] = b.soc * 100.0
            signal_values[(el_id, "sig_voltage")] = v_term
            signal_values[(el_id, "sig_current")] = current
            signal_values[(el_id, "sig_power")] = p_w / 1000.0

        # 4. publish voltage-source signals
        for el_id, cdef in ctx.cdef_of.items():
            if cdef.id == "electric.voltage_source":
                acc(el_id, "sig_voltage", float(ctx.params_of[el_id].get("voltage_V", 400)))

        # 5. persist computed outputs as next-step signal values & record series
        for key, value in step_acc.items():
            signal_values[key] = value
        recorded = set(step_acc.keys()) | set(series.keys())
        for key in recorded:
            lst = series[key]
            while len(lst) < step:  # backfill channels that appear late
                lst.append(0.0)
            lst.append(step_acc.get(key, 0.0))

    # --- assemble channels ----------------------------------------------------
    channels: list[Channel] = []
    for (el_id, port_id), values in sorted(series.items()):
        cdef = ctx.cdef_of.get(el_id)
        el = ctx.elements.get(el_id)
        if cdef is None or el is None:
            continue
        pdef = next((pp for pp in cdef.ports if pp.id == port_id), None)
        if pdef is None:
            continue
        unit = UNIT_BY_GROUP.get(pdef.unitGroup or "No Unit", "-")
        if pdef.id == "sig_soc":
            unit = "%"
        channels.append(Channel(
            elementId=el_id,
            portId=port_id,
            label=f"{el.label} · {pdef.name}",
            unit=unit,
            timeSeries=[{"t": times[i], "value": round(v, 5)} for i, v in enumerate(values)],
        ))

    # --- summary ---------------------------------------------------------------
    summary: list[SummaryValue] = []
    for el_id, b in batteries.items():
        label = ctx.elements[el_id].label
        summary.append(SummaryValue(label=f"{label} — final SOC", value=round(b.soc * 100.0, 2), unit="%"))
        summary.append(SummaryValue(label=f"{label} — energy delivered", value=round(b.energy_out_kwh, 3), unit="kWh"))
        summary.append(SummaryValue(label=f"{label} — internal losses", value=round(b.loss_kwh, 4), unit="kWh"))
    for el_id, e in vs_energy_kwh.items():
        summary.append(SummaryValue(
            label=f"{ctx.elements[el_id].label} — energy supplied", value=round(e, 3), unit="kWh",
        ))
    total_load_kwh = 0.0
    for (el_id, port_id), values in series.items():
        cdef = ctx.cdef_of.get(el_id)
        if cdef and cdef.id in LOAD_TYPES and port_id in ("sig_thrust_power", "sig_traction_power", "sig_power"):
            total_load_kwh += sum(values[:-1]) * dt / 3600.0
    summary.append(SummaryValue(label="Total useful load energy", value=round(total_load_kwh, 3), unit="kWh"))
    summary.append(SummaryValue(label="Simulated duration", value=case.duration, unit="s"))

    has_error = any(m.level == "error" for m in ctx.messages)
    has_warning = any(m.level == "warning" for m in ctx.messages)
    status = "failed" if has_error else ("warning" if has_warning else "success")
    ctx.messages.insert(0, SimMessage(
        level="info",
        text=f"Case '{case.name}' solved: {steps} steps × {dt:g} s, "
             f"{len(channels)} result channels.",
    ))
    return SimResult(
        caseId=case_id,
        status=status,
        messages=ctx.messages,
        channels=channels,
        summary=summary,
    )

"""Causal multi-pass solver.

Per recorded step (the case timeStep) the solver evaluates signal
sources and signal blocks (Script, PID, Lookup, Road Profile), then runs
internal sub-steps (semi-implicit Euler, MAX_SUBSTEP) over the passes:

  driver → mechanics → tire/vehicle → electrical

Mechanics use a small Lagrangian formulation per driveline: independent
coordinates live on the leaf rigid segments; every segment's speed is a
linear function of them (g-vectors) through the joint constraints
(open split: input speed is the torque-weighted mean of the outputs;
locked split: rigid merge). Each sub-step assembles M ẋ = Q (n ≤ ~6)
and solves it directly. Numerically stiff couplings — tire slip and the
clutch's Coulomb characteristic — are linearized implicitly into M.

Gear shifts and live lock/unlock toggles rebuild the driveline plan at
recording boundaries, carrying rotational states over via per-element
anchor speeds.
"""
from __future__ import annotations

import math
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Callable, Optional

from ..library import unit_groups
from ..schemas import Channel, Project, SimMessage, SimResult, SummaryValue
from .maps import TableError, interp1, interp2, parse_table1d, parse_table2d
from .network import (
    Driveline,
    Model,
    ModelError,
    Segment,
    build_model,
    gearbox_ratio,
)
from .profiles import interp_profile, parse_profile
from .scripting import ScriptError, compile_script, run_script

GRAVITY = 9.81
AIR_DENSITY = 1.2
MAX_SUBSTEP = 0.01  # s
V_EPS = 0.5  # m/s — slip regularization
W_EPS = 0.5  # rad/s — static/dynamic brake threshold
CLUTCH_BAND = 0.5  # rad/s — smooth Coulomb band (residual slip under load)
RPM = 60.0 / (2.0 * math.pi)

EmitFn = Callable[[dict], None]
ControlFn = Callable[[], list[dict]]


class SingularMatrixError(RuntimeError):
    """The driveline mass matrix could not be solved (degenerate configuration)."""


def solve_linear(m: list[list[float]], q: list[float]) -> list[float]:
    """Gaussian elimination with partial pivoting (systems are tiny)."""
    n = len(q)
    a = [row[:] + [q[i]] for i, row in enumerate(m)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(a[r][col]))
        if abs(a[piv][col]) < 1e-12:
            raise SingularMatrixError(
                f"pivot {a[piv][col]:.3e} in column {col + 1} of {n}")
        a[col], a[piv] = a[piv], a[col]
        for r in range(col + 1, n):
            fac = a[r][col] / a[col][col]
            if fac:
                for c in range(col, n + 1):
                    a[r][c] -= fac * a[col][c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        s = a[r][n] - sum(a[r][c] * x[c] for c in range(r + 1, n))
        x[r] = s / a[r][r]
    return x


@dataclass
class BatteryState:
    el_id: str
    soc: float
    capacity_wh: float
    min_soc: float
    r0: float
    r1: float
    tau: float
    max_charge_w: float
    ocv_pts: list
    v_rc: float = 0.0
    v_term: float = 0.0
    depleted_flagged: bool = False
    energy_out_wh: float = 0.0
    energy_in_wh: float = 0.0
    loss_wh: float = 0.0
    current: float = 0.0
    power_w: float = 0.0

    def ocv(self) -> float:
        return interp1(self.ocv_pts, max(0.0, min(1.0, self.soc)) * 100.0)


@dataclass
class MotorCache:
    el_id: str
    full_load: list
    loss: list
    drag: list
    q4_scale: float
    rpm: float = 0.0
    torque: float = 0.0
    p_mech_w: float = 0.0
    p_loss_w: float = 0.0
    p_elec_w: float = 0.0


@dataclass
class EngineCache:
    el_id: str
    full_load: list
    drag: list
    fuel_map: list
    idle_rpm: float
    rpm: float = 0.0
    torque: float = 0.0
    fuel_kgh: float = 0.0
    p_mech_w: float = 0.0
    fuel_used_kg: float = 0.0
    stalled_flagged: bool = False


@dataclass
class TankState:
    el_id: str
    capacity_kg: float
    mass_kg: float
    empty_flagged: bool = False


@dataclass
class FuelCellCache:
    el_id: str
    pol: list  # V(I)
    i_max: float
    h2_g_per_kwh: float
    voltage: float = 0.0
    current: float = 0.0
    power_w: float = 0.0
    h2_kgh: float = 0.0
    energy_wh: float = 0.0


@dataclass
class DrivePlan:
    """Per-driveline linear structure for the current joint configuration."""
    n: int = 0
    gvec: list[list[float]] = field(default_factory=list)  # per segment
    x: list[float] = field(default_factory=list)
    coord_root: list[int] = field(default_factory=list)  # segment idx per coordinate
    root_of_seg: list[int] = field(default_factory=list)
    scale_of_seg: list[float] = field(default_factory=list)
    eff_chain: list[float] = field(default_factory=list)  # per segment
    gear_key: tuple = ()
    lock_key: tuple = ()
    over_constrained: bool = False


@dataclass
class DrivelineState:
    dl: Driveline
    plan: DrivePlan = field(default_factory=DrivePlan)
    # channel bookkeeping
    joint_torque_a: dict[str, float] = field(default_factory=dict)
    joint_torque_b: dict[str, float] = field(default_factory=dict)
    joint_speed_in: dict[str, float] = field(default_factory=dict)
    clutch_torque: dict[str, float] = field(default_factory=dict)
    clutch_slip: dict[str, float] = field(default_factory=dict)
    chain_power_w: float = 0.0


class Runtime:
    def __init__(self, model: Model, emit: Optional[EmitFn]):
        self.model = model
        self.emit = emit
        self.messages: list[SimMessage] = []
        self.warned: set[str] = set()
        self.signal_values: dict[tuple[str, str], float] = {}
        # recorded values; None marks "no data yet" gaps from decimated backfill
        self.series: dict[tuple[str, str], list[float | None]] = defaultdict(list)

    def message(self, level: str, text: str) -> None:
        self.messages.append(SimMessage(level=level, text=text))  # type: ignore[arg-type]
        if self.emit:
            self.emit({"type": "message", "level": level, "text": text})

    def warn_once(self, key: str, text: str, level: str = "warning") -> None:
        if key not in self.warned:
            self.warned.add(key)
            self.message(level, text)

    def read_signal(self, el_id: str, port_id: str) -> float | None:
        src = self.model.signal_route.get((el_id, port_id))
        if src is None:
            return None
        return self.signal_values.get(src)

    def publish(self, el_id: str, port_id: str, value: float) -> None:
        self.signal_values[(el_id, port_id)] = value


def _sign(x: float) -> float:
    return 1.0 if x > 0 else (-1.0 if x < 0 else 0.0)


def make_plan(dl: Driveline, params_of: dict, gear_of: dict[str, float]) -> DrivePlan:
    """Resolve the segment tree into coordinates + g-vectors for the
    current lock states and gear ratios. Rigid merges (locked splits) go
    through a weighted union-find; the remaining open-split constraints
    form a homogeneous linear system whose null space provides the
    independent coordinates — this handles shared parents (e.g. a locked
    transfer case above two open axle differentials) uniformly."""
    n_seg = len(dl.segments)
    plan = DrivePlan()
    plan.gear_key = tuple(sorted(
        (g.el_id, gear_of.get(g.el_id, float(params_of[g.el_id].get("default_gear", 1) or 1)))
        for seg in dl.segments for g in seg.gearboxes))
    lock_states = {}
    for j in dl.joints:
        if j.kind == "split":
            lock_states[j.el_id] = bool(params_of[j.el_id].get("locked", j.locked))
    plan.lock_key = tuple(sorted(lock_states.items()))

    # weighted union-find: ω_i = weight[i] · ω_parent[i]
    parent = list(range(n_seg))
    weight = [1.0] * n_seg

    def find(i: int) -> tuple[int, float]:
        w = 1.0
        while parent[i] != i:
            w *= weight[i]
            i = parent[i]
        return i, w

    def union(i: int, j: int, r: float) -> None:
        """Declare ω_i = r · ω_j."""
        ri, wi = find(i)
        rj, wj = find(j)
        if ri == rj:
            return
        # ω_ri = ω_i / wi = r·ω_j / wi = (r·wj/wi)·ω_rj
        parent[ri] = rj
        weight[ri] = r * wj / wi

    for j in dl.joints:
        if j.kind == "split" and lock_states.get(j.el_id, j.locked):
            # locked: both output axes and (via ratio) the input axis are rigid
            union(j.child_a, j.child_b, j.child_b_m / j.child_a_m)
            if j.parent_seg >= 0:
                union(j.parent_seg, j.child_a, j.ratio * j.child_a_m / j.parent_m)

    roots: list[int] = []
    root_of, scale_of = [0] * n_seg, [1.0] * n_seg
    for s in range(n_seg):
        r, w = find(s)
        root_of[s], scale_of[s] = r, w
        if r not in roots:
            roots.append(r)
    plan.root_of_seg, plan.scale_of_seg = root_of, scale_of
    m = len(roots)
    col_of_root = {r: c for c, r in enumerate(roots)}

    # open-split constraints over the group variables:
    #   ω_parent_axis − ratio·((1−f)·ω_a_axis + f·ω_b_axis) = 0
    rows: list[list[float]] = []
    for j in dl.joints:
        if j.kind != "split" or lock_states.get(j.el_id, j.locked) or j.parent_seg < 0:
            continue
        row = [0.0] * m
        row[col_of_root[root_of[j.parent_seg]]] += j.parent_m * scale_of[j.parent_seg]
        row[col_of_root[root_of[j.child_a]]] -= (
            j.ratio * (1.0 - j.f_b) * j.child_a_m * scale_of[j.child_a])
        row[col_of_root[root_of[j.child_b]]] -= (
            j.ratio * j.f_b * j.child_b_m * scale_of[j.child_b])
        if any(abs(v) > 1e-12 for v in row):
            rows.append(row)

    # column order: pivot anchor-less groups first, so groups that carry a
    # wheel/source/prop end up as the free (state) variables
    def group_has_anchor(root: int) -> bool:
        return any(
            (seg.wheels or seg.sources or seg.props)
            for s, seg in enumerate(dl.segments) if root_of[s] == root
        )

    col_order = sorted(range(m), key=lambda c: (group_has_anchor(roots[c]), c))

    # RREF over the permuted columns → pivot/free split + expressions
    a = [row[:] for row in rows]
    pivots: list[tuple[int, int]] = []  # (row, col)
    r_idx = 0
    for col in col_order:
        if r_idx >= len(a):
            break
        piv = max(range(r_idx, len(a)), key=lambda rr: abs(a[rr][col]))
        if abs(a[piv][col]) < 1e-10:
            continue
        a[r_idx], a[piv] = a[piv], a[r_idx]
        pv = a[r_idx][col]
        a[r_idx] = [v / pv for v in a[r_idx]]
        for rr in range(len(a)):
            if rr != r_idx and abs(a[rr][col]) > 1e-12:
                fac = a[rr][col]
                a[rr] = [a[rr][c2] - fac * a[r_idx][c2] for c2 in range(m)]
        pivots.append((r_idx, col))
        r_idx += 1

    pivot_cols = {c for _, c in pivots}
    free_cols = [c for c in col_order if c not in pivot_cols]
    plan.n = len(free_cols)
    if plan.n == 0:
        plan.over_constrained = True
        return plan
    plan.coord_root = [roots[c] for c in free_cols]

    g_col: dict[int, list[float]] = {}
    for k, c in enumerate(free_cols):
        g_col[c] = [1.0 if i == k else 0.0 for i in range(plan.n)]
    for r, c in pivots:  # ω_pivot = −Σ_free R[r][free]·ω_free
        g_col[c] = [-a[r][fc] * 1.0 for fc in free_cols]

    plan.gvec = [
        [scale_of[s] * v for v in g_col[col_of_root[root_of[s]]]]
        for s in range(n_seg)
    ]
    plan.x = [0.0] * plan.n

    # torque-weighted split-efficiency chain below each segment
    split_below: dict[int, object] = {}
    for j in dl.joints:
        if j.kind == "split" and j.parent_seg >= 0:
            split_below[j.parent_seg] = j

    def eff_chain(seg_idx: int, depth: int = 0) -> float:
        if depth > 8:
            return 1.0
        j = split_below.get(seg_idx)
        if j is None:
            return 1.0
        return j.eff * ((1.0 - j.f_b) * eff_chain(j.child_a, depth + 1)
                        + j.f_b * eff_chain(j.child_b, depth + 1))

    plan.eff_chain = [eff_chain(s) for s in range(n_seg)]
    return plan


def simulate(
    project: Project,
    case_id: str,
    emit: Optional[EmitFn] = None,
    control: Optional[ControlFn] = None,
) -> SimResult:
    case = next((c for c in project.cases if c.id == case_id), None)
    if case is None:
        return SimResult(
            caseId=case_id, status="failed", channels=[],
            messages=[SimMessage(level="error", text=f"Simulation case '{case_id}' not found.")],
        )
    gear_of: dict[str, float] = {}
    case_overrides = getattr(case, "parameterOverrides", None) or {}
    try:
        model = build_model(project, gear_of, case_overrides)
    except ModelError as e:
        return SimResult(
            caseId=case_id, status="failed", channels=[],
            messages=[SimMessage(level="error", text=t) for t in e.errors],
        )

    rt = Runtime(model, emit)
    for w in model.warnings:
        rt.message("warning", w)

    dt_rec = max(1e-4, case.timeStep)
    steps = max(1, int(round(case.duration / dt_rec)))
    n_sub = max(1, int(math.ceil(dt_rec / MAX_SUBSTEP)))
    dt = dt_rec / n_sub
    output_every = max(1, int(getattr(case, "outputEvery", 1) or 1))
    pace = max(0.0, float(getattr(case, "realtimeFactor", 0.0) or 0.0))

    def params(el_id: str) -> dict:
        return model.params_of[el_id]

    # ---- element caches ------------------------------------------------------
    batteries: dict[str, BatteryState] = {}
    motors: dict[str, MotorCache] = {}
    engines: dict[str, EngineCache] = {}
    fuelcells: dict[str, FuelCellCache] = {}
    tanks: dict[str, TankState] = {}
    lookup_cache: dict[str, tuple[list, list]] = {}
    pid_state: dict[str, dict[str, float]] = {}
    table_errors: list[str] = []
    for el_id, cdef in model.cdef_of.items():
        p = params(el_id)
        label = model.elements[el_id].label
        try:
            if cdef.id == "battery.generic":
                b = BatteryState(
                    el_id=el_id,
                    soc=float(p.get("initial_soc_pct", 90)) / 100.0,
                    capacity_wh=max(1e-3, float(p.get("capacity_kWh", 60))) * 1000.0,
                    min_soc=float(p.get("min_soc_pct", 10)) / 100.0,
                    r0=max(1e-6, float(p.get("internal_resistance_ohm", 0.08))),
                    r1=max(0.0, float(p.get("rc_resistance_ohm", 0))),
                    tau=max(0.0, float(p.get("rc_time_constant_s", 0))),
                    max_charge_w=max(0.0, float(p.get("max_charge_power_kW", 120))) * 1000.0,
                    ocv_pts=parse_table1d(p.get("ocv_table", {"0": 300, "100": 400})),
                )
                b.v_term = b.ocv()
                batteries[el_id] = b
            elif cdef.id == "motor.emotor":
                motors[el_id] = MotorCache(
                    el_id=el_id,
                    full_load=parse_table2d(p.get("full_load_torque", {"330": {"0": 100}})),
                    loss=parse_table2d(p.get("power_loss", {"0": {"0": 0}})),
                    drag=parse_table1d(p.get("drag_torque", {"0": 0})),
                    q4_scale=max(0.0, float(p.get("q4_torque_scale_pct", 100)) / 100.0),
                )
            elif cdef.id == "engine.combustion":
                engines[el_id] = EngineCache(
                    el_id=el_id,
                    full_load=parse_table1d(p.get("full_load_torque", {"1000": 100})),
                    drag=parse_table1d(p.get("drag_torque", {"0": 20})),
                    fuel_map=parse_table2d(p.get("fuel_map", {"1000": {"0": 1}})),
                    idle_rpm=max(1.0, float(p.get("idle_speed_rpm", 800))),
                )
            elif cdef.id == "fuelcell.stack":
                fuelcells[el_id] = FuelCellCache(
                    el_id=el_id,
                    pol=parse_table1d(p.get("polarization", {"0": 400, "400": 260})),
                    i_max=max(1.0, float(p.get("max_current_A", 400))),
                    h2_g_per_kwh=max(0.0, float(p.get("h2_per_kwh_g", 55))),
                )
            elif cdef.id in ("fuel.tank", "fuel.h2_tank"):
                cap = max(1e-3, float(p.get("capacity_kg", 45)))
                tanks[el_id] = TankState(
                    el_id=el_id, capacity_kg=cap,
                    mass_kg=cap * max(0.0, min(1.0, float(p.get("initial_fill_pct", 90)) / 100.0)),
                )
            elif cdef.id == "signal.lookup":
                lookup_cache[el_id] = (
                    parse_table1d(p.get("table_1d", {"0": 0, "1": 1})),
                    parse_table2d(p.get("table_2d", {"0": {"0": 0}})),
                )
            elif cdef.id == "control.pid":
                pid_state[el_id] = {"integral": 0.0, "prev_err": 0.0}
        except TableError as e:
            table_errors.append(f"'{label}': {e}")
    if table_errors:
        return SimResult(
            caseId=case_id, status="failed", channels=[],
            messages=[SimMessage(level="error", text=t) for t in table_errors],
        )

    script_fns: dict[str, Callable] = {}
    script_states: dict[str, dict] = {}
    for el_id in model.signal_blocks:
        if model.cdef_of[el_id].id != "signal.script":
            continue
        label = model.elements[el_id].label
        try:
            script_fns[el_id] = compile_script(str(params(el_id).get("code", "")), label)
        except ScriptError as e:
            return SimResult(
                caseId=case_id, status="failed", channels=[],
                messages=[SimMessage(level="error", text=str(e))],
            )
        script_states[el_id] = {}

    # ---- driveline & vehicle states ------------------------------------------
    veh_id = model.vehicle
    veh_p = params(veh_id) if veh_id else {}
    veh_mass = max(1.0, float(veh_p.get("mass_kg", 1800))) if veh_id else 0.0
    v = max(0.0, float(veh_p.get("initial_speed_kmh", 0)) / 3.6) if veh_id else 0.0
    distance = 0.0
    driver_integral = 0.0

    dls = [DrivelineState(dl=dl) for dl in model.drivelines]
    el_axis_speed: dict[str, float] = {}  # anchor speeds for plan rebuilds

    def anchor_of_group(dl: Driveline, plan: DrivePlan, coord: int) -> tuple[str, float] | None:
        root = plan.coord_root[coord]
        for s, seg in enumerate(dl.segments):
            if plan.root_of_seg[s] != root:
                continue
            for w in seg.wheels:
                return w.el_id, w.m * plan.scale_of_seg[s]
            for src in seg.sources:
                return src.el_id, src.m * plan.scale_of_seg[s]
            for pr in seg.props:
                return pr.el_id, pr.m * plan.scale_of_seg[s]
        return None

    def rebuild_plan(st: DrivelineState, initial: bool = False) -> None:
        st.plan = make_plan(st.dl, model.params_of, gear_of)
        if st.plan.over_constrained:
            rt.warn_once("overconstrained",
                         "Driveline became kinematically over-constrained — "
                         "its motion is frozen.")
            return
        for k in range(st.plan.n):
            anchor = anchor_of_group(st.dl, st.plan, k)
            if anchor is None:
                st.plan.x[k] = 0.0
                continue
            el_id, factor = anchor
            if initial:
                # initialize wheel-bearing groups from the vehicle speed
                omega = 0.0
                for seg in st.dl.segments:
                    for w in seg.wheels:
                        if w.el_id == el_id and v > 0:
                            omega = v / w.radius
                st.plan.x[k] = omega / factor if factor else 0.0
            else:
                st.plan.x[k] = el_axis_speed.get(el_id, 0.0) / factor if factor else 0.0

    for st in dls:
        rebuild_plan(st, initial=True)

    def seg_speed(st: DrivelineState, s: int) -> float:
        g = st.plan.gvec[s]
        return sum(g[i] * st.plan.x[i] for i in range(st.plan.n))

    # bus lookups
    motor_bus: dict[str, object] = {}
    for bus in model.buses:
        for m_id in bus.motors:
            motor_bus[m_id] = bus
    bus_voltage: dict[int, float] = {}
    for bus in model.buses:
        if bus.battery:
            bus_voltage[bus.id] = batteries[bus.battery].v_term
        elif bus.vsource:
            bus_voltage[bus.id] = float(params(bus.vsource).get("voltage_V", 400))
        elif bus.fuelcell:
            bus_voltage[bus.id] = interp1(fuelcells[bus.fuelcell].pol, 0.0)
        elif bus.dcdc_out:
            bus_voltage[bus.id] = float(params(bus.dcdc_out[0]).get("output_voltage_V", 400))
        else:
            bus_voltage[bus.id] = 0.0

    vsource_energy_wh: dict[str, float] = defaultdict(float)
    dcdc_flows: dict[str, tuple[float, float]] = {}
    bus_loads: dict[int, float] = {}

    # ---- live parameter updates ------------------------------------------------
    def apply_set_param(el_id: str, key: str, value) -> None:
        if el_id not in model.params_of:
            return
        model.params_of[el_id][key] = value
        label = model.elements[el_id].label
        if key == "locked":
            for st in dls:
                if any(j.el_id == el_id for j in st.dl.joints):
                    rebuild_plan(st)
            return
        pdef = next(
            (pp for pp in model.cdef_of[el_id].parameters if pp.key == key), None)
        if pdef is not None and pdef.variability == "fixed":
            rt.warn_once(
                f"live-structural:{el_id}:{key}",
                f"'{label}.{key}' changed — structural parameters take effect on the next run.",
                level="info",
            )
            return
        try:
            if el_id in motors:
                mc = motors[el_id]
                p = params(el_id)
                mc.q4_scale = max(0.0, float(p.get("q4_torque_scale_pct", 100)) / 100.0)
                mc.full_load = parse_table2d(p.get("full_load_torque", {}))
                mc.loss = parse_table2d(p.get("power_loss", {}))
                mc.drag = parse_table1d(p.get("drag_torque", {}))
            if el_id in engines:
                ec = engines[el_id]
                p = params(el_id)
                ec.idle_rpm = max(1.0, float(p.get("idle_speed_rpm", ec.idle_rpm)))
                ec.full_load = parse_table1d(p.get("full_load_torque", {}))
                ec.drag = parse_table1d(p.get("drag_torque", {}))
                ec.fuel_map = parse_table2d(p.get("fuel_map", {}))
            if el_id in fuelcells:
                fc = fuelcells[el_id]
                p = params(el_id)
                fc.i_max = max(1.0, float(p.get("max_current_A", fc.i_max)))
                fc.h2_g_per_kwh = max(0.0, float(p.get("h2_per_kwh_g", fc.h2_g_per_kwh)))
                fc.pol = parse_table1d(p.get("polarization", {}))
            if el_id in batteries:
                b = batteries[el_id]
                p = params(el_id)
                b.min_soc = float(p.get("min_soc_pct", 10)) / 100.0
                b.r0 = max(1e-6, float(p.get("internal_resistance_ohm", b.r0)))
                b.max_charge_w = max(0.0, float(p.get("max_charge_power_kW", 120))) * 1000.0
                b.ocv_pts = parse_table1d(p.get("ocv_table", {}))
        except TableError:
            rt.warn_once(f"live-table:{el_id}", f"Live table edit on '{label}' is invalid — ignored.")
        p = params(el_id)
        for st in dls:
            for seg in st.dl.segments:
                for w in seg.wheels:
                    if w.el_id == el_id:
                        w.mu = max(0.0, float(p.get("mu", w.mu)))
                        w.c_slip = max(0.1, float(p.get("slip_stiffness", w.c_slip)))
                        w.c_rr = max(0.0, float(p.get("rolling_resistance", w.c_rr)))
                        w.load_share = max(0.0, float(p.get("vehicle_load_share_pct", 25)) / 100.0)
                for br in seg.brakes:
                    if br.el_id == el_id:
                        br.max_torque = max(0.0, float(p.get("max_torque_Nm", br.max_torque)))

    # ---- behaviors ---------------------------------------------------------------
    def motor_torque(mc: MotorCache, demand: float, omega_m: float) -> float:
        rpm = abs(omega_m) * RPM
        volts = bus_voltage.get(motor_bus[mc.el_id].id, 0.0) if mc.el_id in motor_bus else 0.0
        if volts <= 1.0:
            rt.warn_once(f"deadbus:{mc.el_id}",
                         f"E-Motor '{model.elements[mc.el_id].label}' has no live electrical "
                         f"supply — it produces no torque.")
            t_raw = 0.0
        else:
            if volts < mc.full_load[0][0] - 1e-9 or volts > mc.full_load[-1][0] + 1e-9:
                rt.warn_once(
                    f"mapclamp:{mc.el_id}:volt",
                    f"E-Motor '{model.elements[mc.el_id].label}' is operating outside its "
                    f"full-load map's voltage range ({volts:.0f} V) — torque clamped to "
                    f"the nearest map edge.",
                )
            t_full = interp2(mc.full_load, volts, rpm)
            demand = max(-1.0, min(1.0, demand))
            t_raw = demand * t_full * (mc.q4_scale if demand < 0 else 1.0)
        t_drag = interp1(mc.drag, rpm)
        t_net = t_raw - _sign(omega_m) * t_drag
        p_loss = interp2(mc.loss, rpm, abs(t_raw)) * 1000.0
        mc.rpm = rpm
        mc.torque = t_raw
        mc.p_mech_w = t_raw * omega_m
        mc.p_loss_w = p_loss
        mc.p_elec_w = mc.p_mech_w + p_loss
        return t_net

    def engine_torque(ec: EngineCache, omega_e: float) -> float:
        rpm = abs(omega_e) * RPM
        throttle = rt.read_signal(ec.el_id, "sig_throttle_in")
        throttle = max(0.0, min(1.0, throttle if throttle is not None else 0.0))
        on_sig = rt.read_signal(ec.el_id, "sig_on_in")
        on = (on_sig is None) or (on_sig >= 0.5)  # unwired → always on
        tank = tanks.get(model.fuel_tank) if model.fuel_tank else None
        if on and tank is not None and tank.mass_kg <= 0:
            on = False
            if not ec.stalled_flagged:
                ec.stalled_flagged = True
                rt.message("warning",
                           f"Fuel tank empty — engine '{model.elements[ec.el_id].label}' shut off.")
        t_prod = 0.0
        if on:
            if rpm > ec.full_load[-1][0] + 1e-9:
                rt.warn_once(
                    f"mapclamp:{ec.el_id}:rpm",
                    f"Engine '{model.elements[ec.el_id].label}' exceeds its full-load "
                    f"curve's speed range ({rpm:.0f} 1/min) — torque clamped to the "
                    f"curve edge.",
                )
            # idle governor: throttle floor rises as speed falls below idle
            governor = max(0.0, min(1.0, (ec.idle_rpm - rpm) / (0.25 * ec.idle_rpm)))
            t_prod = max(throttle, governor) * interp1(ec.full_load, rpm)
        t_net = t_prod - _sign(omega_e) * interp1(ec.drag, rpm)
        fuel = interp2(ec.fuel_map, rpm, max(0.0, t_prod)) if on else 0.0
        if tank is not None and fuel > 0:
            burn = fuel / 3600.0 * dt
            tank.mass_kg = max(0.0, tank.mass_kg - burn)
            ec.fuel_used_kg += burn
        elif tank is None and fuel > 0:
            ec.fuel_used_kg += fuel / 3600.0 * dt
        ec.rpm = rpm
        ec.torque = t_prod
        ec.fuel_kgh = fuel
        ec.p_mech_w = t_prod * omega_e
        return t_net

    def wheel_force(w, omega_ref: float) -> tuple[float, float, float]:
        n_load = w.load_share * veh_mass * GRAVITY if veh_id else 0.0
        if n_load <= 0:
            return 0.0, 0.0, 0.0
        omega_w = w.m * omega_ref
        v_den = max(abs(v), V_EPS)
        slip = (omega_w * w.radius - v) / v_den
        fx_over_n = max(-w.mu, min(w.mu, w.c_slip * slip))
        force = n_load * fx_over_n
        saturated = abs(w.c_slip * slip) >= w.mu
        damping = 0.0 if saturated else n_load * w.c_slip * w.radius ** 2 * w.m ** 2 / v_den
        return force, -force * w.radius * w.m, damping

    def brake_capacity(seg: Segment) -> float:
        cap = 0.0
        for br in seg.brakes:
            cmd = rt.read_signal(br.el_id, "sig_demand_in") or 0.0
            cmd = max(0.0, min(1.0, cmd))
            rt.publish(br.el_id, "sig_torque", cmd * br.max_torque)
            cap += cmd * br.max_torque * br.m
        return cap

    def prop_torque(seg: Segment, omega_ref: float) -> float:
        total = 0.0
        for pr in seg.props:
            omega_p = pr.m * omega_ref
            rpm_p = abs(omega_p) * RPM
            total += -_sign(omega_p) * pr.t_ref * (rpm_p / pr.n_ref) ** 2 * pr.m
        return total

    def apply_brake(tau_other: float, omega: float, cap: float, j_over_dt: float) -> float:
        if cap <= 0:
            return 0.0
        if abs(omega) > W_EPS:
            return -_sign(omega) * cap
        return -max(-cap, min(cap, tau_other + j_over_dt * omega))

    # ---- main loop -----------------------------------------------------------
    cancelled = False
    times: list[float] = []
    t_start_wall = time.monotonic()
    last_forces: dict[str, float] = {}

    for step in range(steps + 1):
        t = step * dt_rec

        if control:
            for msg in control():
                if msg.get("type") == "cancel":
                    cancelled = True
                elif msg.get("type") == "set_param":
                    apply_set_param(str(msg.get("elementId")), str(msg.get("key")), msg.get("value"))
        if cancelled:
            rt.message("info", f"Simulation cancelled by user at t = {t:g} s.")
            break

        # -- signal sources ----------------------------------------------------
        for el_id, cdef in model.cdef_of.items():
            p = params(el_id)
            if cdef.id == "signal.constant":
                rt.publish(el_id, "sig_out", float(p.get("value", 0)))
            elif cdef.id == "signal.driving_task":
                pts = parse_profile(str(p.get("profile", "")))
                scale = float(p.get("scale_pct", 100)) / 100.0
                rt.publish(el_id, "sig_demand",
                           interp_profile(pts, t, bool(p.get("repeat", False))) * scale)

        # -- signal blocks (topological order, once per recorded step) ----------
        block_failed = False
        for el_id in model.signal_blocks:
            el = model.elements[el_id]
            kind = model.cdef_of[el_id].id
            p = params(el_id)
            if kind == "signal.script":
                inputs = {}
                for port in (el.dynamicPorts or []):
                    if port.direction == "input":
                        inputs[port.id] = rt.read_signal(el_id, port.id) or 0.0
                try:
                    outs = run_script(script_fns[el_id], el.label, t, dt_rec, inputs,
                                      script_states[el_id], dict(p))
                except ScriptError as e:
                    rt.message("error", str(e))
                    block_failed = True
                    break
                out_ids = {po.id for po in (el.dynamicPorts or []) if po.direction == "output"}
                for key, value in outs.items():
                    if key in out_ids:
                        rt.publish(el_id, key, value)
                    else:
                        rt.warn_once(f"script-out:{el_id}:{key}",
                                     f"Script '{el.label}' returned '{key}' which is not one "
                                     f"of its output ports — value dropped.")
            elif kind == "control.pid":
                sp = rt.read_signal(el_id, "sig_setpoint_in") or 0.0
                fb = rt.read_signal(el_id, "sig_feedback_in") or 0.0
                st_pid = pid_state[el_id]
                err = sp - fb
                kp = float(p.get("kp", 1.0))
                ki = float(p.get("ki", 0.0))
                kd = float(p.get("kd", 0.0))
                lo = float(p.get("out_min", -1.0))
                hi = float(p.get("out_max", 1.0))
                deriv = (err - st_pid["prev_err"]) / dt_rec
                out_unsat = kp * err + ki * (st_pid["integral"] + err * dt_rec) + kd * deriv
                if lo <= out_unsat <= hi or err * out_unsat < 0:  # anti-windup
                    st_pid["integral"] += err * dt_rec
                out = max(lo, min(hi, kp * err + ki * st_pid["integral"] + kd * deriv))
                st_pid["prev_err"] = err
                rt.publish(el_id, "sig_out", out)
            elif kind == "signal.lookup":
                t1, t2 = lookup_cache[el_id]
                x_in = rt.read_signal(el_id, "sig_x_in") or 0.0
                if str(p.get("mode", "1D")) == "2D":
                    y_in = rt.read_signal(el_id, "sig_y_in") or 0.0
                    rt.publish(el_id, "sig_out", interp2(t2, x_in, y_in))
                else:
                    rt.publish(el_id, "sig_out", interp1(t1, x_in))
            elif kind == "signal.road_profile":
                pts = parse_profile(str(p.get("profile", "")))
                mode = str(p.get("mode", "distance"))
                if mode == "distance":
                    x_in = rt.read_signal(el_id, "sig_distance_in")
                    if x_in is None and veh_id:
                        x_in = rt.signal_values.get((veh_id, "sig_distance"), 0.0)
                    x_in = x_in or 0.0
                else:
                    x_in = t
                rt.publish(el_id, "sig_grade",
                           interp_profile(pts, x_in, bool(p.get("repeat", False))))
        if block_failed:
            break

        # -- gear selection (rebuild plans on shift) -----------------------------
        for st in dls:
            changed = False
            for seg in st.dl.segments:
                for gb in seg.gearboxes:
                    sig = rt.read_signal(gb.el_id, "sig_gear_in")
                    gear = round(sig) if sig is not None else float(
                        params(gb.el_id).get("default_gear", 1) or 1)
                    if gear_of.get(gb.el_id) != gear:
                        gear_of[gb.el_id] = gear
                        changed = True
            if changed:
                # ratios are baked into segment reflections — re-extract them
                try:
                    new_model = build_model(project, gear_of, case_overrides)
                except ModelError:
                    new_model = None
                if new_model is not None:
                    for st2, new_dl in zip(dls, new_model.drivelines):
                        st2.dl = new_dl
                        rebuild_plan(st2)
                break

        # -- sub-steps -----------------------------------------------------------
        solver_failed = False
        for _ in range(n_sub):
            # driver ------------------------------------------------------------
            drv_id = model.driver
            if drv_id:
                dp = params(drv_id)
                target_kmh = rt.read_signal(drv_id, "sig_target_in")
                if target_kmh is None:
                    rt.warn_once("driver-no-target",
                                 "Driver has no Target Speed signal — it holds 0 km/h.",
                                 level="info")
                    target_kmh = 0.0
                # actual-speed feedback: wired signal, else the vehicle state
                fb_kmh = rt.read_signal(drv_id, "sig_speed_in")
                if fb_kmh is None:
                    fb_kmh = v * 3.6
                kp = float(dp.get("driver_kp", 0.35))
                ki = float(dp.get("driver_ki", 0.08))
                regen_w = max(0.0, min(1.0, float(dp.get("regen_weight_pct", 80)) / 100.0))
                err = target_kmh - fb_kmh
                cmd_unsat = kp * err + ki * driver_integral
                cmd = max(-1.0, min(1.0, cmd_unsat))
                if cmd == cmd_unsat or err * cmd_unsat < 0:
                    driver_integral += err * dt

                t_motor_cap = 0.0
                for st in dls:
                    if st.plan.over_constrained or not st.plan.n:
                        continue
                    has_wheels = any(seg.wheels for seg in st.dl.segments)
                    if not has_wheels:
                        continue
                    ones = [1.0] * st.plan.n
                    for s_idx, seg in enumerate(st.dl.segments):
                        for src in seg.sources:
                            if src.kind != "motor" or src.el_id not in motors:
                                continue
                            mc = motors[src.el_id]
                            g = st.plan.gvec[s_idx]
                            r_eff = abs(src.m * sum(g[i] * ones[i] for i in range(st.plan.n)))
                            omega_m = src.m * seg_speed(st, s_idx)
                            volts = (bus_voltage.get(motor_bus[mc.el_id].id, 0.0)
                                     if mc.el_id in motor_bus else 0.0)
                            t_q4 = interp2(mc.full_load, volts, abs(omega_m) * RPM) * mc.q4_scale
                            t_motor_cap += t_q4 * r_eff * src.eff * st.plan.eff_chain[s_idx]
                fr_cap = sum(br.max_torque * br.m
                             for st in dls for seg in st.dl.segments for br in seg.brakes)
                taper = max(0.0, min(1.0, v / 3.0))
                batt_cap_w = sum(b.max_charge_w for b in batteries.values())
                radii = [w.radius for st in dls for seg in st.dl.segments for w in seg.wheels]
                r_avg = sum(radii) / len(radii) if radii else 0.33
                t_batt_cap = batt_cap_w * r_avg / max(v, V_EPS)
                regen_avail = min(t_motor_cap, t_batt_cap) * taper

                if cmd >= 0:
                    traction_cmd, brake_cmd = cmd, 0.0
                else:
                    d = -cmd
                    t_req = d * (fr_cap + regen_w * regen_avail)
                    t_rg = min(regen_w * regen_avail, t_req)
                    t_fr = min(fr_cap, t_req - t_rg)
                    traction_cmd = -t_rg / max(t_motor_cap, 1e-6) if t_motor_cap > 0 else 0.0
                    traction_cmd = max(-1.0, traction_cmd)
                    brake_cmd = t_fr / max(fr_cap, 1e-6) if fr_cap > 0 else 0.0
                rt.publish(drv_id, "sig_traction_cmd", traction_cmd)
                rt.publish(drv_id, "sig_brake_cmd", brake_cmd)
                rt.publish(drv_id, "sig_accel_pedal", max(0.0, cmd))
                rt.publish(drv_id, "sig_brake_pedal", max(0.0, -cmd))

            # mechanics ------------------------------------------------------------
            for st in dls:
                plan = st.plan
                if plan.over_constrained or plan.n == 0:
                    continue
                n = plan.n
                m_mat = [[0.0] * n for _ in range(n)]
                q_vec = [0.0] * n
                omega_seg = [seg_speed(st, s) for s in range(len(st.dl.segments))]
                # torque-source bookkeeping for joint channels
                torque_above: dict[int, float] = defaultdict(float)  # root seg → torque at axis
                for s_idx, seg in enumerate(st.dl.segments):
                    g = plan.gvec[s_idx]
                    j_seg = max(1e-4, seg.inertia)
                    for i in range(n):
                        gi = g[i]
                        if gi == 0.0:
                            continue
                        for k in range(i, n):
                            m_mat[i][k] += j_seg * gi * g[k]
                    tau = 0.0
                    for src in seg.sources:
                        omega_src = src.m * omega_seg[s_idx]
                        if src.kind == "motor" and src.el_id in motors:
                            demand = rt.read_signal(src.el_id, "sig_demand_in") or 0.0
                            t_net = motor_torque(motors[src.el_id], demand, omega_src)
                        elif src.kind == "engine" and src.el_id in engines:
                            t_net = engine_torque(engines[src.el_id], omega_src)
                        else:
                            continue
                        driving = t_net * omega_src >= 0
                        eff = src.eff * plan.eff_chain[s_idx]
                        t_at_ref = t_net * src.m * (eff if driving else 1.0 / max(1e-3, eff))
                        tau += t_at_ref
                        torque_above[plan.root_of_seg[s_idx]] += (
                            t_at_ref / max(1e-9, plan.scale_of_seg[s_idx]))
                    for w in seg.wheels:
                        f, tq, dmp = wheel_force(w, omega_seg[s_idx])
                        tau += tq
                        last_forces[w.el_id] = f
                        if dmp > 0:
                            for i in range(n):
                                gi = g[i]
                                if gi == 0.0:
                                    continue
                                for k in range(i, n):
                                    m_mat[i][k] += dt * dmp * gi * g[k]
                    tau += prop_torque(seg, omega_seg[s_idx])
                    cap = brake_capacity(seg)
                    if cap > 0:
                        # static hold only when this segment carries a coordinate
                        coord = None
                        for kk in range(n):
                            if plan.coord_root[kk] == plan.root_of_seg[s_idx]:
                                coord = kk
                                break
                        if coord is not None and abs(omega_seg[s_idx]) <= W_EPS:
                            j_over_dt = max(m_mat[coord][coord], 1e-4) / dt
                            tau += apply_brake(tau, omega_seg[s_idx], cap, j_over_dt)
                        else:
                            tau += -_sign(omega_seg[s_idx]) * cap
                    for i in range(n):
                        q_vec[i] += g[i] * tau

                # clutches: smooth Coulomb coupling, implicit in Δω
                for j in st.dl.joints:
                    if j.kind != "clutch":
                        continue
                    engage = rt.read_signal(j.el_id, "sig_engage_in")
                    engage = max(0.0, min(1.0, engage if engage is not None else 1.0))
                    cap_c = engage * max(0.0, float(params(j.el_id).get("max_torque_Nm", 0)))
                    ga = [j.child_a_m * x for x in plan.gvec[j.child_a]]
                    gb = [j.child_b_m * x for x in plan.gvec[j.child_b]]
                    d_omega = (j.child_a_m * omega_seg[j.child_a]
                               - j.child_b_m * omega_seg[j.child_b])
                    st.clutch_slip[j.el_id] = d_omega
                    if cap_c <= 0:
                        st.clutch_torque[j.el_id] = 0.0
                        continue
                    k_c = cap_c / CLUTCH_BAND
                    t_c = max(-cap_c, min(cap_c, k_c * d_omega))
                    st.clutch_torque[j.el_id] = t_c
                    rel = [ga[i] - gb[i] for i in range(n)]
                    for i in range(n):
                        q_vec[i] += -t_c * ga[i] + t_c * gb[i]
                        if abs(k_c * d_omega) < cap_c:  # unclamped → implicit
                            ri = rel[i]
                            if ri == 0.0:
                                continue
                            for k in range(i, n):
                                m_mat[i][k] += dt * k_c * ri * rel[k]

                for i in range(n):  # symmetrize
                    for k in range(i + 1, n):
                        m_mat[k][i] = m_mat[i][k]
                try:
                    alpha = solve_linear(m_mat, q_vec)
                except SingularMatrixError:
                    rt.message(
                        "error",
                        f"Driveline equations became numerically singular at t = {t:g} s "
                        "(check gear ratios, inertias and joint configuration) — "
                        "solve aborted.",
                    )
                    solver_failed = True
                    break
                for i in range(n):
                    x_new = plan.x[i] + alpha[i] * dt
                    # brake zero-crossing clamp on braked coordinates
                    root = plan.coord_root[i]
                    braked = any(
                        seg.brakes and plan.root_of_seg[s2] == root
                        for s2, seg in enumerate(st.dl.segments)
                    )
                    if braked and plan.x[i] * x_new < 0:
                        x_new = 0.0
                    plan.x[i] = x_new

                # update anchors + joint channels
                omega_seg = [seg_speed(st, s) for s in range(len(st.dl.segments))]
                st.chain_power_w = 0.0
                for s_idx, seg in enumerate(st.dl.segments):
                    for w in seg.wheels:
                        el_axis_speed[w.el_id] = w.m * omega_seg[s_idx]
                    for src in seg.sources:
                        el_axis_speed[src.el_id] = src.m * omega_seg[s_idx]
                        cache = motors.get(src.el_id) or engines.get(src.el_id)
                        if cache is not None:
                            st.chain_power_w += getattr(cache, "p_mech_w", 0.0)
                    for pr in seg.props:
                        el_axis_speed[pr.el_id] = pr.m * omega_seg[s_idx]
                for j in st.dl.joints:
                    if j.kind != "split":
                        continue
                    omega_in = (j.parent_m * omega_seg[j.parent_seg]
                                if j.parent_seg >= 0 else 0.0)
                    st.joint_speed_in[j.el_id] = omega_in
                    t_cross = (torque_above.get(plan.root_of_seg[j.parent_seg], 0.0)
                               * plan.scale_of_seg[j.parent_seg] / max(1e-9, j.parent_m)
                               if j.parent_seg >= 0 else 0.0)
                    locked_now = bool(params(j.el_id).get("locked", j.locked))
                    t_out = t_cross * j.ratio * j.eff
                    if not locked_now:
                        st.joint_torque_a[j.el_id] = (1.0 - j.f_b) * t_out
                        st.joint_torque_b[j.el_id] = j.f_b * t_out
                    else:
                        # emergent split: each side consumes inertia + local loads
                        for side, child, child_m in (("a", j.child_a, j.child_a_m),
                                                     ("b", j.child_b, j.child_b_m)):
                            seg = st.dl.segments[child]
                            g = plan.gvec[child]
                            a_axis = sum(g[i] * alpha[i] for i in range(n))
                            local = sum(wheel_force(w, omega_seg[child])[1] for w in seg.wheels)
                            val = max(1e-4, seg.inertia) * a_axis - local
                            if side == "a":
                                st.joint_torque_a[j.el_id] = val
                            else:
                                st.joint_torque_b[j.el_id] = val

            if solver_failed:
                break

            # vehicle --------------------------------------------------------------
            if veh_id:
                vp = params(veh_id)
                cda = max(0.0, float(vp.get("cd", 0.28))) * max(0.0, float(vp.get("frontal_area_m2", 2.2)))
                grade_pct = rt.read_signal(veh_id, "sig_grade_in") or 0.0
                f_tire = 0.0
                f_roll = 0.0
                for st in dls:
                    if st.plan.over_constrained or not st.plan.n:
                        continue
                    for s_idx, seg in enumerate(st.dl.segments):
                        omega_ref = seg_speed(st, s_idx)
                        for w in seg.wheels:
                            f, _, _ = wheel_force(w, omega_ref)
                            f_tire += f
                            n_load = w.load_share * veh_mass * GRAVITY
                            f_roll += w.c_rr * n_load
                f_aero = 0.5 * AIR_DENSITY * cda * v * v
                f_grade = veh_mass * GRAVITY * grade_pct / 100.0
                roll_taper = max(0.0, min(1.0, v / 0.3))
                accel = (f_tire - f_aero - f_roll * roll_taper - f_grade) / veh_mass
                v = max(0.0, v + accel * dt)
                distance += v * dt
                rt.publish(veh_id, "sig_speed", v * 3.6)
                rt.publish(veh_id, "sig_distance", distance)

            # electrical -----------------------------------------------------------
            dcdc_draw: dict[str, float] = {}
            for bus in model.buses:
                load_w = 0.0
                for c_id in bus.consumers:
                    p_kw = rt.read_signal(c_id, "sig_demand_in")
                    if p_kw is None:
                        p_kw = float(params(c_id).get("power_kW", 0))
                    p_w = max(0.0, p_kw) * 1000.0
                    rt.publish(c_id, "sig_power", p_w / 1000.0)
                    load_w += p_w
                for m_id in bus.motors:
                    load_w += motors[m_id].p_elec_w if m_id in motors else 0.0
                for d_id in bus.dcdc_in:
                    load_w += dcdc_draw.get(d_id, 0.0)
                # DC-DC feeding a battery bus works at a power setpoint
                if bus.battery:
                    for d_id in bus.dcdc_out:
                        sp_kw = rt.read_signal(d_id, "sig_setpoint_in")
                        if sp_kw is None:
                            sp_kw = float(params(d_id).get("power_setpoint_kW", 0))
                        sp_w = max(0.0, sp_kw) * 1000.0
                        eta = max(1e-3, float(params(d_id).get("efficiency_pct", 97)) / 100.0)
                        dcdc_draw[d_id] = sp_w / eta
                        dcdc_flows[d_id] = (sp_w / eta, sp_w)
                        load_w -= sp_w
                bus_loads[bus.id] = load_w
                for n_id in bus.nodes:
                    rt.publish(n_id, "sig_power", load_w / 1000.0)

                if bus.battery:
                    b = batteries[bus.battery]
                    p_w = load_w
                    if b.soc <= b.min_soc and p_w > 0:
                        if not b.depleted_flagged:
                            b.depleted_flagged = True
                            rt.message("warning",
                                       f"Battery '{model.elements[b.el_id].label}' reached minimum "
                                       f"SOC ({b.min_soc * 100:.0f} %) at t = {t:.0f} s — no further discharge.")
                        p_w = 0.0
                    if p_w < -b.max_charge_w:
                        rt.warn_once(f"chg:{b.el_id}",
                                     f"Charging exceeds max charge power of "
                                     f"'{model.elements[b.el_id].label}' — clamped.")
                        p_w = -b.max_charge_w
                    a_volt = b.ocv() - b.v_rc
                    disc = a_volt * a_volt - 4.0 * b.r0 * p_w
                    if disc < 0:
                        rt.warn_once(f"maxp:{b.el_id}",
                                     f"Battery '{model.elements[b.el_id].label}' demand exceeds its "
                                     f"deliverable power — clamped at the maximum power point.")
                        current = a_volt / (2.0 * b.r0)
                        p_w = a_volt * a_volt / (4.0 * b.r0)
                    else:
                        current = (a_volt - math.sqrt(disc)) / (2.0 * b.r0)
                    v_term = a_volt - current * b.r0
                    if b.r1 > 0 and b.tau > 0:
                        b.v_rc = (b.v_rc + dt * current * b.r1 / b.tau) / (1.0 + dt / b.tau)
                    e_wh = b.ocv() * current * dt / 3600.0
                    b.soc = max(0.0, min(1.0, b.soc - e_wh / b.capacity_wh))
                    if current >= 0:
                        b.energy_out_wh += p_w * dt / 3600.0
                    else:
                        b.energy_in_wh += -p_w * dt / 3600.0
                    b.loss_wh += current * current * b.r0 * dt / 3600.0
                    b.current, b.power_w, b.v_term = current, p_w, v_term
                    bus_voltage[bus.id] = v_term
                elif bus.vsource:
                    vs_p = params(bus.vsource)
                    bus_voltage[bus.id] = float(vs_p.get("voltage_V", 400))
                    vsource_energy_wh[bus.vsource] += load_w * dt / 3600.0
                    rt.publish(bus.vsource, "sig_power", load_w / 1000.0)
                    rt.publish(bus.vsource, "sig_voltage", bus_voltage[bus.id])
                elif bus.fuelcell:
                    fc = fuelcells[bus.fuelcell]
                    tank = tanks.get(model.h2_tank) if model.h2_tank else None
                    p_req = max(0.0, load_w)
                    if tank is not None and tank.mass_kg <= 0:
                        if not tank.empty_flagged:
                            tank.empty_flagged = True
                            rt.message("warning", "Hydrogen tank empty — fuel cell shut down.")
                        p_req = 0.0
                    p_max = interp1(fc.pol, fc.i_max) * fc.i_max
                    if p_req > p_max:
                        rt.warn_once(f"fcmax:{fc.el_id}",
                                     f"Fuel cell '{model.elements[fc.el_id].label}' demand exceeds "
                                     f"its maximum power — clamped.")
                        p_req = p_max
                    lo_i, hi_i = 0.0, fc.i_max
                    for _ in range(40):
                        mid = 0.5 * (lo_i + hi_i)
                        if interp1(fc.pol, mid) * mid < p_req:
                            lo_i = mid
                        else:
                            hi_i = mid
                    current = 0.5 * (lo_i + hi_i)
                    volt = interp1(fc.pol, current)
                    fc.current, fc.voltage, fc.power_w = current, volt, p_req
                    fc.h2_kgh = p_req / 1000.0 * fc.h2_g_per_kwh / 1000.0
                    fc.energy_wh += p_req * dt / 3600.0
                    if tank is not None:
                        tank.mass_kg = max(0.0, tank.mass_kg - fc.h2_kgh / 3600.0 * dt)
                    bus_voltage[bus.id] = volt
                elif bus.dcdc_out:
                    d_id = bus.dcdc_out[0]
                    eta = max(1e-3, float(params(d_id).get("efficiency_pct", 97)) / 100.0)
                    draw = max(0.0, load_w) / eta
                    dcdc_draw[d_id] = draw
                    dcdc_flows[d_id] = (draw, max(0.0, load_w))
                    bus_voltage[bus.id] = float(params(d_id).get("output_voltage_V", 400))
                else:
                    if load_w > 1.0:
                        rt.warn_once(f"nosrc:{bus.id}",
                                     "An electrical bus has load but no source — demand is unmet.")
                    bus_voltage[bus.id] = 0.0

        if solver_failed:
            break

        # -- record / publish --------------------------------------------------
        # Always publish (so signal routing stays fresh for the next step); only
        # append to the series on recorded steps, so "store every N steps"
        # decimates the stored/streamed output. The last step is always kept.
        do_record = (step % output_every == 0) or (step == steps)
        if do_record:
            times.append(t)
        rec_index = len(times) - 1
        rec = rt.series

        def record(el_id: str, port_id: str, value: float) -> None:
            rt.publish(el_id, port_id, value)
            if not do_record:
                return
            lst = rec[(el_id, port_id)]
            while len(lst) < rec_index:
                lst.append(None)  # no data yet — a gap, not a zero
            lst.append(value)

        for el_id, cdef in model.cdef_of.items():
            tdef = cdef.id
            if tdef == "signal.constant":
                record(el_id, "sig_out", rt.signal_values.get((el_id, "sig_out"), 0.0))
            elif tdef == "signal.driving_task":
                record(el_id, "sig_demand", rt.signal_values.get((el_id, "sig_demand"), 0.0))
            elif tdef == "signal.script":
                for po in (model.elements[el_id].dynamicPorts or []):
                    if po.direction == "output":
                        record(el_id, po.id, rt.signal_values.get((el_id, po.id), 0.0))
            elif tdef in ("control.pid", "signal.lookup"):
                record(el_id, "sig_out", rt.signal_values.get((el_id, "sig_out"), 0.0))
            elif tdef == "signal.road_profile":
                record(el_id, "sig_grade", rt.signal_values.get((el_id, "sig_grade"), 0.0))
            elif tdef == "vehicle.body":
                for pid in ("sig_speed", "sig_distance"):
                    record(el_id, pid, rt.signal_values.get((el_id, pid), 0.0))
            elif tdef == "driver.driver":
                for pid in ("sig_traction_cmd", "sig_brake_cmd",
                            "sig_accel_pedal", "sig_brake_pedal"):
                    record(el_id, pid, rt.signal_values.get((el_id, pid), 0.0))
            elif tdef == "battery.generic" and el_id in batteries:
                b = batteries[el_id]
                record(el_id, "sig_soc", b.soc * 100.0)
                record(el_id, "sig_voltage", b.v_term)
                record(el_id, "sig_current", b.current)
                record(el_id, "sig_power", b.power_w / 1000.0)
            elif tdef == "motor.emotor" and el_id in motors:
                mc = motors[el_id]
                record(el_id, "sig_speed", mc.rpm)
                record(el_id, "sig_torque", mc.torque)
                record(el_id, "sig_mech_power", mc.p_mech_w / 1000.0)
                record(el_id, "sig_elec_power", mc.p_elec_w / 1000.0)
                record(el_id, "sig_losses", mc.p_loss_w / 1000.0)
            elif tdef == "engine.combustion" and el_id in engines:
                ec = engines[el_id]
                record(el_id, "sig_speed", ec.rpm)
                record(el_id, "sig_torque", ec.torque)
                record(el_id, "sig_fuel_rate", ec.fuel_kgh)
                record(el_id, "sig_power", ec.p_mech_w / 1000.0)
            elif tdef == "fuelcell.stack" and el_id in fuelcells:
                fc = fuelcells[el_id]
                record(el_id, "sig_voltage", fc.voltage)
                record(el_id, "sig_current", fc.current)
                record(el_id, "sig_power", fc.power_w / 1000.0)
                record(el_id, "sig_h2_rate", fc.h2_kgh)
            elif tdef in ("fuel.tank", "fuel.h2_tank") and el_id in tanks:
                tk = tanks[el_id]
                record(el_id, "sig_level", 100.0 * tk.mass_kg / tk.capacity_kg)
                record(el_id, "sig_mass", tk.mass_kg)
            elif tdef == "electric.constant_drive":
                record(el_id, "sig_power", rt.signal_values.get((el_id, "sig_power"), 0.0))
            elif tdef == "electric.voltage_source":
                record(el_id, "sig_power", rt.signal_values.get((el_id, "sig_power"), 0.0))
                record(el_id, "sig_voltage", rt.signal_values.get((el_id, "sig_voltage"), 0.0))
            elif tdef == "electric.node":
                record(el_id, "sig_power", rt.signal_values.get((el_id, "sig_power"), 0.0))
            elif tdef == "controller.dcdc" and el_id in dcdc_flows:
                p_in, p_out = dcdc_flows[el_id]
                record(el_id, "sig_power_in", p_in / 1000.0)
                record(el_id, "sig_power_out", p_out / 1000.0)
                record(el_id, "sig_losses", (p_in - p_out) / 1000.0)
            elif tdef == "mech.brake":
                record(el_id, "sig_torque", rt.signal_values.get((el_id, "sig_torque"), 0.0))

        for st in dls:
            plan = st.plan
            for j in st.dl.joints:
                if j.kind == "split":
                    record(j.el_id, "sig_torque_a", st.joint_torque_a.get(j.el_id, 0.0))
                    record(j.el_id, "sig_torque_b", st.joint_torque_b.get(j.el_id, 0.0))
                    record(j.el_id, "sig_speed_in",
                           abs(st.joint_speed_in.get(j.el_id, 0.0)) * RPM)
                else:
                    record(j.el_id, "sig_torque", st.clutch_torque.get(j.el_id, 0.0))
                    record(j.el_id, "sig_slip_speed",
                           st.clutch_slip.get(j.el_id, 0.0) * RPM)
            if plan.over_constrained or not plan.n:
                continue
            for s_idx, seg in enumerate(st.dl.segments):
                omega_ref = seg_speed(st, s_idx)
                for w in seg.wheels:
                    omega_w = w.m * omega_ref
                    force = last_forces.get(w.el_id, 0.0)
                    v_den = max(abs(v), V_EPS)
                    slip = (omega_w * w.radius - v) / v_den if veh_id else 0.0
                    record(w.el_id, "sig_speed", abs(omega_w) * RPM)
                    record(w.el_id, "sig_slip", slip)
                    record(w.el_id, "sig_force", force)
                    record(w.el_id, "sig_torque", force * w.radius)
                for el_id2, m2 in seg.element_ms.items():
                    tdef2 = model.cdef_of[el_id2].id
                    if tdef2 == "mech.node":
                        record(el_id2, "sig_speed", abs(m2 * omega_ref) * RPM)
                    elif tdef2 == "mech.final_drive":
                        record(el_id2, "sig_speed_out", abs(m2 * omega_ref) * RPM)
                        record(el_id2, "sig_power", st.chain_power_w / 1000.0)
                    elif tdef2 == "mech.gearbox":
                        record(el_id2, "sig_speed_out", abs(m2 * omega_ref) * RPM)
                        record(el_id2, "sig_gear", gear_of.get(
                            el_id2, float(params(el_id2).get("default_gear", 1) or 1)))
                    elif tdef2 == "mech.shaft":
                        record(el_id2, "sig_power", st.chain_power_w / 1000.0)
                for pr in seg.props:
                    record(pr.el_id, "sig_speed", abs(pr.m * omega_ref) * RPM)
                    omega_p = pr.m * omega_ref
                    rpm_p = abs(omega_p) * RPM
                    record(pr.el_id, "sig_shaft_power",
                           abs(pr.t_ref * (rpm_p / pr.n_ref) ** 2 * omega_p) / 1000.0)

        if emit and do_record:
            emit({
                "type": "step",
                "t": t,
                "pct": round(100.0 * step / steps, 1),
                "values": {f"{el}:{port}": round(val[-1], 5)
                           for (el, port), val in rec.items() if len(val) == rec_index + 1},
            })

        if pace > 0 and step < steps:
            target_wall = (t + dt_rec) / pace
            while not cancelled:
                lag = target_wall - (time.monotonic() - t_start_wall)
                if lag <= 0:
                    break
                time.sleep(min(0.05, lag))
                if control:
                    for msg in control():
                        if msg.get("type") == "cancel":
                            cancelled = True
                        elif msg.get("type") == "set_param":
                            apply_set_param(str(msg.get("elementId")), str(msg.get("key")),
                                            msg.get("value"))

    # ---- assemble result -------------------------------------------------------
    unit_map = unit_groups()
    channels: list[Channel] = []
    port_lookup: dict[tuple[str, str], object] = {}
    for el_id, cdef in model.cdef_of.items():
        el = model.elements[el_id]
        for p in (list(cdef.ports) + list(el.dynamicPorts or [])):
            port_lookup[(el_id, p.id)] = p
    for (el_id, port_id), values in sorted(rt.series.items()):
        el = model.elements.get(el_id)
        pdef = port_lookup.get((el_id, port_id))
        if el is None or pdef is None:
            continue
        unit = unit_map.get(getattr(pdef, "unitGroup", None) or "No Unit", "-")
        channels.append(Channel(
            elementId=el_id,
            portId=port_id,
            label=f"{el.label} · {pdef.name}",
            unit=unit,
            timeSeries=[
                {"t": times[i], "value": None if vv is None else round(vv, 5)}
                for i, vv in enumerate(values)
            ],
        ))

    summary: list[SummaryValue] = []
    for b in batteries.values():
        label = model.elements[b.el_id].label
        summary.append(SummaryValue(label=f"{label} — final SOC", value=round(b.soc * 100.0, 2), unit="%"))
        summary.append(SummaryValue(label=f"{label} — energy delivered", value=round(b.energy_out_wh / 1000.0, 3), unit="kWh"))
        summary.append(SummaryValue(label=f"{label} — energy recuperated", value=round(b.energy_in_wh / 1000.0, 3), unit="kWh"))
        summary.append(SummaryValue(label=f"{label} — internal losses", value=round(b.loss_wh / 1000.0, 4), unit="kWh"))
    for ec in engines.values():
        summary.append(SummaryValue(
            label=f"{model.elements[ec.el_id].label} — fuel used",
            value=round(ec.fuel_used_kg, 3), unit="kg"))
    for fc in fuelcells.values():
        summary.append(SummaryValue(
            label=f"{model.elements[fc.el_id].label} — energy supplied",
            value=round(fc.energy_wh / 1000.0, 3), unit="kWh"))
    for vs_id, e_wh in vsource_energy_wh.items():
        summary.append(SummaryValue(
            label=f"{model.elements[vs_id].label} — energy supplied",
            value=round(e_wh / 1000.0, 3), unit="kWh"))
    if veh_id:
        summary.append(SummaryValue(label="Distance driven", value=round(distance / 1000.0, 3), unit="km"))
        net_wh = sum(b.energy_out_wh - b.energy_in_wh for b in batteries.values())
        if distance > 100 and net_wh > 0:
            summary.append(SummaryValue(
                label="Consumption", value=round(net_wh / 10.0 / (distance / 1000.0), 2),
                unit="kWh/100km"))
        fuel_kg = sum(ec.fuel_used_kg for ec in engines.values())
        if distance > 100 and fuel_kg > 0:
            density = 0.745  # gasoline default when no tank declares one
            if model.fuel_tank:
                try:
                    density = max(1e-3, float(
                        params(model.fuel_tank).get("density_kg_per_l", density)))
                except (TypeError, ValueError):
                    pass
            liters = fuel_kg / density
            summary.append(SummaryValue(
                label="Fuel consumption",
                value=round(liters * 100.0 / (distance / 1000.0), 2), unit="l/100km"))
    summary.append(SummaryValue(label="Simulated duration", value=times[-1] if times else 0.0, unit="s"))

    has_error = any(m.level == "error" for m in rt.messages)
    has_warning = any(m.level == "warning" for m in rt.messages) or cancelled
    status = "failed" if has_error else ("warning" if has_warning else "success")
    rec_note = f", stored every {output_every}" if output_every > 1 else ""
    rt.messages.insert(0, SimMessage(
        level="info",
        text=f"Case '{case.name}' solved: {steps} steps × {dt_rec:g} s "
             f"({n_sub} sub-steps each), {len(times)} points recorded{rec_note}, "
             f"{len(channels)} result channels.",
    ))
    return SimResult(
        caseId=case_id,
        status=status,
        messages=rt.messages,
        channels=channels,
        summary=summary,
    )

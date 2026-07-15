"""Master contract tests: Gauss–Seidel ordering, ZOH multi-rate scheduling,
event/error propagation, live-parameter routing, and route validation.
"""
import pytest

from app.solver.master import Master, SlaveStepError
from app.solver.slave import ParamResult, Slave, StepResult, VarDef


class Counter(Slave):
    """Outputs how many steps it has taken; records its step sizes."""

    def __init__(self, slave_id: str, rate_divisor: int = 1):
        self.slave_id = slave_id
        self.rate_divisor = rate_divisor
        self.n = 0
        self.step_sizes: list[float] = []

    def variables(self):
        return [VarDef(name=f"{self.slave_id}.out", causality="output", start=0.0)]

    def setup(self, t0):
        self.n = 0
        self.step_sizes = []

    def set_inputs(self, values):
        pass

    def do_step(self, t, h):
        self.n += 1
        self.step_sizes.append(h)
        return StepResult()

    def get_outputs(self):
        return {f"{self.slave_id}.out": float(self.n)}


class Recorder(Slave):
    """Captures its routed input at every one of its communication points."""

    def __init__(self, slave_id: str = "rec", rate_divisor: int = 1):
        self.slave_id = slave_id
        self.rate_divisor = rate_divisor
        self.current = 0.0
        self.received: list[float] = []

    def variables(self):
        return [VarDef(name=f"{self.slave_id}.in", causality="input")]

    def setup(self, t0):
        self.current = 0.0
        self.received = []

    def set_inputs(self, values):
        self.current = values.get(f"{self.slave_id}.in", self.current)

    def do_step(self, t, h):
        self.received.append(self.current)
        return StepResult()

    def get_outputs(self):
        return {}


def _run(master: Master, steps: int, dt: float = 0.01):
    master.initialize(0.0)
    for k in range(steps):
        master.step(k * dt, dt)


def test_gauss_seidel_propagates_within_a_step():
    src, rec = Counter("src"), Recorder()
    m = Master([src, rec], {"rec.in": "src.out"})
    _run(m, 3)
    # source ordered first: recorder sees this step's fresh value
    assert rec.received == [1.0, 2.0, 3.0]


def test_feedback_across_order_boundary_is_delayed_one_step():
    src, rec = Counter("src"), Recorder()
    m = Master([rec, src], {"rec.in": "src.out"})
    _run(m, 3)
    # recorder ordered first: it sees the previous step's value (seeded 0.0)
    assert rec.received == [0.0, 1.0, 2.0]


def test_multirate_zoh_and_step_size():
    slow = Counter("slow", rate_divisor=3)
    rec = Recorder()
    m = Master([slow, rec], {"rec.in": "slow.out"})
    _run(m, 9, dt=0.01)
    # slow slave stepped at k = 0, 3, 6 with h = 3·dt
    assert slow.n == 3
    assert slow.step_sizes == [pytest.approx(0.03)] * 3
    # its output is held (ZOH) for the fast recorder in between
    assert rec.received == [1.0, 1.0, 1.0, 2.0, 2.0, 2.0, 3.0, 3.0, 3.0]


def test_error_status_raises_slave_step_error():
    class Broken(Counter):
        def do_step(self, t, h):
            return StepResult(status="error", detail="boom")

    m = Master([Broken("bad")], {})
    m.initialize(0.0)
    with pytest.raises(SlaveStepError) as ei:
        m.step(0.0, 0.01)
    assert ei.value.slave_id == "bad" and "boom" in str(ei.value)


def test_events_are_returned_and_forwarded():
    class Shifter(Counter):
        def do_step(self, t, h):
            super().do_step(t, h)
            return StepResult(events=["reconfigured"] if self.n == 2 else [])

    seen: list[tuple[str, str]] = []
    m = Master([Shifter("gb")], {}, on_event=lambda sid, ev: seen.append((sid, ev)))
    m.initialize(0.0)
    assert m.step(0.0, 0.01) == []
    assert m.step(0.01, 0.01) == ["reconfigured"]
    assert seen == [("gb", "reconfigured")]


def test_parameter_routing_declared_owner_and_broadcast():
    class Tunable(Counter):
        def __init__(self, slave_id):
            super().__init__(slave_id)
            self.gain = 1.0

        def variables(self):
            return super().variables() + [
                VarDef(name=f"{self.slave_id}.gain", causality="parameter")]

        def set_parameter(self, name, value) -> ParamResult:
            if name == f"{self.slave_id}.gain":
                self.gain = float(value)  # type: ignore[arg-type]
                return "applied"
            return "invalid"

    class Wholesale(Counter):
        """Claims any parameter of 'its' element without declaring them."""

        def set_parameter(self, name, value) -> ParamResult:
            return "deferred" if name.startswith("el-x.") else "invalid"

    tun, whole = Tunable("tun"), Wholesale("whole")
    m = Master([whole, tun], {})
    assert m.set_parameter("tun.gain", 2.5) == "applied"  # declared → direct
    assert tun.gain == 2.5
    assert m.set_parameter("el-x.ratio", 4.0) == "deferred"  # broadcast, claimed
    assert m.set_parameter("nobody.owns_this", 1) == "invalid"


def test_check_flags_dangling_routes():
    m = Master(
        [Counter("src"), Recorder()],
        {"rec.in": "src.out", "rec.in2": "src.out", "rec.in3": "ghost.out"},
    )
    problems = m.check()
    assert any("rec.in2" in p for p in problems)  # undeclared input
    assert any("ghost.out" in p for p in problems)  # unproduced source
    assert not any("'rec.in'" in p for p in problems)


def test_duplicate_slave_ids_rejected():
    with pytest.raises(ValueError):
        Master([Counter("dup"), Counter("dup")], {})

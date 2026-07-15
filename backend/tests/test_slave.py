"""Slave protocol contract tests, exercised through a toy integrator slave.

These pin the lifecycle semantics (setup → set_inputs → do_step →
get_outputs, state save/restore, live-parameter results) that both the
wrapped domain solvers and imported FMUs must honor.
"""
import pytest

from app.solver.slave import ParamResult, Slave, StepResult, VarDef, split_var, var_name


class IntegratorSlave(Slave):
    """dx/dt = gain · u — the smallest possible stateful slave."""

    slave_id = "int1"

    def __init__(self) -> None:
        self.gain = 1.0
        self.x = 0.0
        self.u = 0.0

    def variables(self) -> list[VarDef]:
        return [
            VarDef(name=var_name("int1", "u"), causality="input"),
            VarDef(name=var_name("int1", "x"), causality="output", start=0.0),
            VarDef(name=var_name("int1", "gain"), causality="parameter",
                   variability="tunable", start=1.0),
        ]

    def setup(self, t0: float) -> None:
        self.x = 0.0
        self.u = 0.0

    def set_inputs(self, values) -> None:
        self.u = values.get("int1.u", self.u)

    def do_step(self, t: float, h: float) -> StepResult:
        self.x += self.gain * self.u * h
        return StepResult()

    def get_outputs(self) -> dict[str, float]:
        return {"int1.x": self.x}

    def set_parameter(self, name: str, value: object) -> ParamResult:
        if name == "int1.gain":
            self.gain = float(value)  # type: ignore[arg-type]
            return "applied"
        return "invalid"

    def get_state(self):
        return (self.x, self.u, self.gain)

    def set_state(self, state) -> None:
        self.x, self.u, self.gain = state


def test_var_name_round_trip():
    assert var_name("el-1", "sig_out") == "el-1.sig_out"
    assert split_var("el-1.sig_out") == ("el-1", "sig_out")
    # keys may themselves contain dots — only the first one splits
    assert split_var("el-1.a.b") == ("el-1", "a.b")


def test_lifecycle_and_stepping():
    s = IntegratorSlave()
    names = {v.name: v for v in s.variables()}
    assert names["int1.u"].causality == "input"
    assert names["int1.x"].causality == "output"
    assert names["int1.gain"].causality == "parameter"

    s.setup(0.0)
    s.set_inputs({"int1.u": 2.0})
    for k in range(10):
        assert s.do_step(k * 0.1, 0.1).status == "ok"
    assert s.get_outputs()["int1.x"] == pytest.approx(2.0)


def test_live_parameter_and_state_rollback():
    s = IntegratorSlave()
    s.setup(0.0)
    s.set_inputs({"int1.u": 1.0})
    s.do_step(0.0, 1.0)
    snapshot = s.get_state()
    assert snapshot is not None  # capability declared

    assert s.set_parameter("int1.gain", 3.0) == "applied"
    assert s.set_parameter("int1.nope", 1.0) == "invalid"
    s.do_step(1.0, 1.0)
    assert s.get_outputs()["int1.x"] == pytest.approx(4.0)

    s.set_state(snapshot)  # roll back the second step (iterative-master hook)
    assert s.get_outputs()["int1.x"] == pytest.approx(1.0)
    assert s.gain == pytest.approx(1.0)


def test_defaults_declare_missing_capabilities():
    class MinimalSlave(Slave):
        slave_id = "min"

        def variables(self):
            return []

        def setup(self, t0):
            pass

        def set_inputs(self, values):
            pass

        def do_step(self, t, h):
            return StepResult()

        def get_outputs(self):
            return {}

    s = MinimalSlave()
    assert s.get_state() is None  # canGetAndSetFMUState = false
    assert s.set_parameter("min.x", 1) == "invalid"
    assert s.rate_divisor == 1
    with pytest.raises(NotImplementedError):
        s.set_state(object())

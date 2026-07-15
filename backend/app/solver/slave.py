"""Co-simulation slave interface — the Phase-1 architecture contract.

The solver is being restructured into a co-simulation *master* that steps
domain *slaves* (mechanical driveline + vehicle, electrical buses, control
blocks, driver, tanks — later thermal) on a shared communication grid.
Component models (motor, engine, battery, …) compose *inside* their domain
slave; rigid mechanical couplings are never co-simulation boundaries.

The interface deliberately mirrors FMI Co-Simulation semantics so that an
imported FMU (FMI 2.0/3.0 CS, wrapped via fmpy) is just another slave:

    FMI concept                          here
    -----------------------------------------------------------------
    modelDescription variables           Slave.variables() → [VarDef]
    causality                            VarDef.causality
    variability (fixed vs tunable)       VarDef.variability
    declared start value                 VarDef.start
    instantiate + initialization mode    Slave.setup(t0)
    fmiSet… (inputs / tunables)          Slave.set_inputs / set_parameter
    fmiDoStep(t, h)                      Slave.do_step(t, h) → StepResult
    fmiGet… (outputs)                    Slave.get_outputs()
    get/setFMUState (optional cap.)      Slave.get_state() / set_state()
    terminate / reset                    Slave.reset()
    fixed communication-step multiple    Slave.rate_divisor

Variable naming: every exchanged variable is namespaced as
"elementId.portId" (signals) or "elementId.paramKey" (parameters), so the
master's connection graph maps 1:1 onto project wiring and results channels.

Master v1 is Gauss–Seidel and non-iterative: slaves are stepped in a fixed
order with zero-order-hold inputs; algebraic loops resolve with a
one-communication-step delay (identical to the pre-refactor coupling, so the
golden fixtures stay valid). ``get_state``/``set_state`` exist now so an
iterative (rollback) master can be added later without touching slaves that
already implement them; returning ``None`` declares the capability as
unsupported — exactly FMI's ``canGetAndSetFMUState`` flag.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Literal, Mapping, Optional

Causality = Literal["parameter", "input", "output", "local"]
Variability = Literal["fixed", "tunable"]
# result of a live parameter write: applied immediately, deferred to the next
# run (structural), or rejected (unknown/invalid value)
ParamResult = Literal["applied", "deferred", "invalid"]


@dataclass(frozen=True)
class VarDef:
    """One exchanged variable — the internal mirror of an FMI variable."""

    name: str  # "elementId.portId" / "elementId.paramKey"
    causality: Causality
    variability: Variability = "tunable"
    unit: str = "-"
    unitGroup: Optional[str] = None  # library unit group (display mapping)
    start: Optional[float] = None
    description: str = ""


@dataclass
class StepResult:
    """Outcome of one communication step.

    ``events`` carries structural notifications the master must react to
    (e.g. "reconfigured" after a gear shift rebuilt the driveline plan) —
    the internal analogue of FMI 3.0 event signaling. ``detail`` explains
    an ``error`` status in user-facing terms.
    """

    status: Literal["ok", "error"] = "ok"
    events: list[str] = field(default_factory=list)
    detail: str = ""


def var_name(element_id: str, key: str) -> str:
    """Namespaced variable name for an element's port or parameter."""
    return f"{element_id}.{key}"


def split_var(name: str) -> tuple[str, str]:
    """Inverse of :func:`var_name` (splits on the first dot)."""
    element_id, _, key = name.partition(".")
    return element_id, key


class Slave(ABC):
    """A co-simulation slave. Domain solvers and imported FMUs implement this.

    Lifecycle: ``variables()`` may be called at any time after construction;
    ``setup(t0)`` enters initialization (states take their start values);
    then per communication point the master calls ``set_inputs`` →
    ``do_step`` → ``get_outputs``. ``reset`` returns to the pre-``setup``
    state so a slave instance can be reused for another run.
    """

    #: slave identity used in logs, error messages and master scheduling
    slave_id: str = ""

    #: step every Nth master micro-step (decision #4: integer rate divisors
    #: on one global clock; 1 = every micro-step)
    rate_divisor: int = 1

    @abstractmethod
    def variables(self) -> list[VarDef]:
        """Declare every exchanged variable (the modelDescription analogue)."""

    @abstractmethod
    def setup(self, t0: float) -> None:
        """Initialize internal states for a run starting at ``t0``."""

    @abstractmethod
    def set_inputs(self, values: Mapping[str, float]) -> None:
        """Write input variables (by VarDef name) for the upcoming step."""

    @abstractmethod
    def do_step(self, t: float, h: float) -> StepResult:
        """Advance internal states from ``t`` to ``t + h`` (may sub-step)."""

    @abstractmethod
    def get_outputs(self) -> dict[str, float]:
        """Read output (and local/recorded) variables after a step."""

    def set_parameter(self, name: str, value: object) -> ParamResult:
        """Write a parameter live. Default: nothing is writable."""
        return "invalid"

    def get_state(self) -> Optional[object]:
        """Opaque state snapshot for rollback/checkpointing.

        ``None`` means the capability is unsupported (FMI:
        ``canGetAndSetFMUState = false``); an iterative master must then
        fall back to non-iterative coupling across this slave.
        """
        return None

    def set_state(self, state: object) -> None:
        """Restore a snapshot from :meth:`get_state`."""
        raise NotImplementedError(f"slave '{self.slave_id}' cannot restore state")

    def reset(self) -> None:
        """Return to the pre-``setup`` state (default: nothing to do)."""

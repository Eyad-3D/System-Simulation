"""Sanity tests for the v1 solver, validation and API on the demo project."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.solver import parse_profile, interp_profile, simulate  # noqa: E402
from app.storage import load_project  # noqa: E402
from app.validation import validate_project  # noqa: E402


def test_profile_parsing():
    pts = parse_profile("0:15; 30:110; 120:95")
    assert pts == [(0.0, 15.0), (30.0, 110.0), (120.0, 95.0)]
    assert interp_profile(pts, 15, False) == 62.5
    assert interp_profile(pts, 999, False) == 95.0
    assert interp_profile(pts, -5, False) == 15.0


def test_demo_project_validates_clean():
    project = load_project("fc-airplane")
    checks = validate_project(project)
    assert not [c for c in checks if c.level == "error"], [c.text for c in checks]


def test_demo_mission_simulation():
    project = load_project("fc-airplane")
    result = simulate(project, "case-mission")
    assert result.status == "success"
    channels = {c.label: c for c in result.channels}

    # peak: 110 kW thrust / 0.8 prop / 0.94 motor / 0.97 dcdc × 4 branches
    battery_power = channels["Main Battery · Discharge Power"]
    peak = max(p["value"] for p in battery_power.timeSeries)
    assert abs(peak - 603.2) < 0.5

    soc = channels["Main Battery · SOC"].timeSeries
    assert soc[0]["value"] > soc[-1]["value"]  # battery discharges
    assert 60 < soc[-1]["value"] < 75

    # motor stays under its 150 kW limit → no clamping warnings
    assert not [m for m in result.messages if m.level == "warning"]


def test_unconnected_load_fails_checks():
    project = load_project("fc-airplane")
    root = project.systems[0]
    root.connections = [c for c in root.connections if c.id != "c-motor1-prop1"]
    checks = validate_project(project)
    errors = [c.text for c in checks if c.level == "error"]
    assert any("Propeller 1" in t for t in errors)


def test_api_roundtrip():
    client = TestClient(app)
    assert client.get("/api/health").json()["status"] == "ok"

    lib = client.get("/api/library").json()["components"]
    assert any(c["id"] == "battery.generic" for c in lib)

    project = client.get("/api/projects/fc-airplane").json()
    assert project["name"] == "FC Airplane"

    checks = client.post("/api/validate", json={"project": project}).json()
    assert not [c for c in checks if c["level"] == "error"]

    result = client.post(
        "/api/simulate", json={"project": project, "caseId": "case-mission"}
    ).json()
    assert result["status"] == "success"
    assert len(result["channels"]) > 30

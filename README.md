# SimStudio — CRUISE M-style System Simulation Tool

A web-based replica of AVL CRUISE M's core workflow: build a system topology
from a component library, wire elements together (including signal / data-bus
connections), run a simulation, and inspect results — all inside a
desktop-grade, dockable-panel UI.

![Topology editor](docs/doc-topology.png)

> **Physics disclaimer** — every component uses simplified, clearly-labeled
> placeholder physics (flat efficiencies, linear OCV battery, quasi-static
> power flow). SimStudio v1 demonstrates the *workflow*, not AVL-grade
> component fidelity.

## Features (v1)

| Area | What works |
|---|---|
| **Topology builder** | Drag components from the searchable library tree onto a React Flow canvas, connect ports (kind-checked), pan/zoom, multi-select, delete, undo/redo (Ctrl+Z / Ctrl+Y), minimap toggle |
| **Component library** | 14 components across 9 categories, defined declaratively in `backend/app/library/components.json` — grows without code changes |
| **Hierarchy** | Sub-system containers: double-click to drill in, breadcrumb bar to navigate back up |
| **Data Bus Connections** | 4-pane grid (Element 1 → Ports → Element 2 → Ports, filterable, with Unit Group columns) + connections list; canvas signal wiring is stored on the same bus |
| **Solver** | Quasi-static fixed-step solver: load demand (propeller / wheel / constant drive) propagates backward through shaft → motor → DC-DC → node → battery with per-component losses; battery SOC integrates forward |
| **Data Checks** | Pre-run validation: unconnected required ports, port-kind mismatches, parameter ranges, source reachability, missing demand signals |
| **Results** | Channel picker (grouped per element), multi-channel time-series chart, summary table (final SOC, energy, losses), CSV export; results stored per case |
| **Messages** | Timestamped run log with severity levels |
| **Layer Configurations** | Toggle electrical / mechanical / signal connection layers on the canvas |
| **Persistence** | Save/load projects on the backend (single JSON file per project), plus browser Export / Import |
| **UI shell** | Ribbon (Project / Home / Simulations / Results + visual stubs), dockable & resizable panels (Dockview), bottom project tab strip, status bar |

![Results view](docs/doc-results.png)
![Data bus connections](docs/doc-databus.png)

## Quickstart

Two processes: a FastAPI backend (solver, validation, library, persistence)
and a Vite dev server (UI). The Vite server proxies `/api` to the backend.

```bash
# 1. backend  (Python ≥ 3.11)
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000

# 2. frontend (Node ≥ 20)
cd frontend
npm install
npm run dev            # → http://localhost:5173
```

The demo project **FC Airplane** (battery → HV node → 4× DC-DC → E-Motor →
Propeller, driving task on the data bus, auxiliary sub-system) loads
automatically. Open the **Simulations** ribbon tab and press **Run**, then
explore the **Results** center tab.

If the backend is not running the UI still works from bundled data
(topology editing only); save / checks / simulation are disabled and a
warning appears in Messages.

### Tests

```bash
cd backend
python -m pytest tests/     # solver physics, validation, API round-trip
cd frontend
npm run build               # type-check + production build
```

## Architecture

```
frontend/  React 19 + TypeScript + Vite
  ├─ Dockview        dockable panel shell (library / canvas / properties / bottom tabs)
  ├─ React Flow      topology canvas with custom element nodes & kind-colored edges
  ├─ Zustand         project graph, selection, undo history, results, messages
  ├─ Recharts        results time-series charts
  └─ Tailwind CSS    dense engineering-tool styling

backend/   Python + FastAPI
  ├─ app/library/components.json   declarative component catalog (ports, params, physics hints)
  ├─ app/schemas.py                pydantic models mirroring the shared JSON data model
  ├─ app/solver.py                 quasi-static backward power-propagation solver
  ├─ app/validation.py             "Data Checks" pre-run validation
  ├─ app/storage.py                one JSON file per project
  └─ projects/fc-airplane.json     demo project
```

### REST API

| Method & path | Purpose |
|---|---|
| `GET /api/library` | Component definitions |
| `GET /api/projects` | List saved projects |
| `GET/PUT/DELETE /api/projects/{id}` | Load / save / delete a project |
| `POST /api/validate` | Run Data Checks on a project payload |
| `POST /api/simulate` | Validate + solve one case, returns channels / summary / messages |

## Data model

A project is a single JSON document (see `backend/projects/fc-airplane.json`):
`Project → SystemNode[] (hierarchical) → ElementInstance[] + Connection[]`,
plus project-level `DataBusConnection[]` and `SimCase[]`. Component types are
referenced by id and resolved against the library, so parameters live as
sparse overrides on the instance.

## Component library (v1)

| Category | Components |
|---|---|
| Base Electric | Voltage Source, Electric Node, Constant Drive |
| Battery | Generic Battery (SOC + internal resistance) |
| Motor | E-Motor (flat efficiency, power limit) |
| Electric Controllers | DC-DC Converter |
| Vehicles / Propulsion | Propeller, Wheel (road-load model) |
| General Rotational Mechanics | Shaft |
| Signal Source | Constant, Driving Task (piecewise-linear profile) |
| Boundaries | Ground, Ambient |
| Containers | System (drillable sub-system) |

## Solver notes (intentionally simplified)

At every timestep: signal sources are evaluated and routed over the data bus;
each load computes its demand (driving-task signal or fallback parameter) and
pulls power backward through the graph — the traversal is direction-aware
(a DC-DC only supplies at Terminal B, a motor only at its shaft), electric
nodes split demand across supplying branches, and each component applies its
flat efficiency. Batteries then solve `P = V·I` with `V = V_oc(SOC) − I·R`,
clamp at the maximum power point, integrate SOC, and stop discharging at
minimum SOC (with warnings surfaced to Messages).

## Decisions on the spec's open questions

- **Browser app**, not Tauri/Electron — save/load is backend-managed, with
  Export/Import as the file-based escape hatch.
- **Demo project ships pre-built** (the electric aircraft example).
- **Lucide** icon set.
- Dockview's React wrapper is the separate `dockview-react` package (v7).
- Run status/results use plain REST (no WebSocket): the v1 solver finishes in
  well under a second for realistic model sizes, so streaming added no value.

## Known v1 limitations

- Sub-system containers are organizational: physical connections cannot cross
  a container boundary (signals can, via the Data Bus).
- No thermal/fluid solving — those domains exist in the data model only.
- Charging (negative power flow), efficiency maps and drive cycles from CSV
  are not implemented.
- The 3D Viewer tab, bookmark tool, and Optimization/Parameters ribbon tabs
  are visual stubs, as scoped.

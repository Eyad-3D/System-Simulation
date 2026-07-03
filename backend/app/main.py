"""SimStudio backend — FastAPI app.

Endpoints:
  GET  /api/library            component library definitions
  GET  /api/projects           saved project list
  GET  /api/projects/{id}      load a project
  PUT  /api/projects/{id}      save a project
  DELETE /api/projects/{id}    delete a project
  POST /api/validate           run Data Checks on a project
  POST /api/simulate           run a simulation case, returns SimResult
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import storage
from .library import load_library
from .schemas import DataCheck, Project, SimResult, SimulateRequest, ValidateRequest
from .solver import simulate
from .validation import validate_project

app = FastAPI(title="SimStudio API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # dev tool — the Vite dev server proxies /api anyway
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "service": "simstudio-backend"}


@app.get("/api/library")
def get_library() -> dict:
    return {"components": [c.model_dump() for c in load_library()]}


@app.get("/api/projects")
def get_projects() -> list[dict]:
    return storage.list_projects()


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> Project:
    try:
        return storage.load_project(project_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/api/projects/{project_id}")
def put_project(project_id: str, project: Project) -> dict:
    if project.id != project_id:
        raise HTTPException(status_code=400, detail="Project id mismatch")
    try:
        storage.save_project(project)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"saved": project_id}


@app.delete("/api/projects/{project_id}")
def remove_project(project_id: str) -> dict:
    try:
        deleted = storage.delete_project(project_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    return {"deleted": project_id}


@app.post("/api/validate")
def validate(req: ValidateRequest) -> list[DataCheck]:
    return validate_project(req.project)


@app.post("/api/simulate")
def run_simulation(req: SimulateRequest) -> SimResult:
    checks = validate_project(req.project)
    errors = [c for c in checks if c.level == "error"]
    if errors:
        return SimResult(
            caseId=req.caseId,
            status="failed",
            messages=[{"level": "error", "text": f"Data check failed: {c.text}"} for c in errors],
            channels=[],
        )
    return simulate(req.project, req.caseId)

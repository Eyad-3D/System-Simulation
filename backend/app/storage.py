"""Project persistence — one JSON file per project (spec §1: single-file projects)."""
from __future__ import annotations

import json
import re
from pathlib import Path

from .schemas import Project

PROJECTS_DIR = Path(__file__).parent.parent / "projects"


def _safe_name(project_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", project_id):
        raise ValueError(f"Invalid project id: {project_id!r}")
    return project_id


def project_path(project_id: str) -> Path:
    return PROJECTS_DIR / f"{_safe_name(project_id)}.json"


def list_projects() -> list[dict]:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(PROJECTS_DIR.glob("*.json")):
        try:
            raw = json.loads(f.read_text(encoding="utf-8"))
            out.append({
                "id": raw.get("id", f.stem),
                "name": raw.get("name", f.stem),
                "description": raw.get("description"),
            })
        except (json.JSONDecodeError, OSError):
            continue
    return out


def load_project(project_id: str) -> Project:
    path = project_path(project_id)
    if not path.exists():
        raise FileNotFoundError(project_id)
    return Project.model_validate_json(path.read_text(encoding="utf-8"))


def save_project(project: Project) -> None:
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    path = project_path(project.id)
    path.write_text(project.model_dump_json(indent=2), encoding="utf-8")


def delete_project(project_id: str) -> bool:
    path = project_path(project_id)
    if path.exists():
        path.unlink()
        return True
    return False

"""Component library — loaded from a declarative JSON file so the catalog
can grow without code changes (spec §4.1 / §5)."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from .schemas import ComponentDef

LIBRARY_PATH = Path(__file__).parent / "library" / "components.json"


@lru_cache(maxsize=1)
def _load_raw() -> dict:
    return json.loads(LIBRARY_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def load_library() -> list[ComponentDef]:
    return [ComponentDef.model_validate(c) for c in _load_raw()["components"]]


@lru_cache(maxsize=1)
def unit_groups() -> dict[str, str]:
    """unitGroup name → display unit; the single source of truth for units."""
    return dict(_load_raw().get("unitGroups", {}))


def library_by_id() -> dict[str, ComponentDef]:
    return {c.id: c for c in load_library()}

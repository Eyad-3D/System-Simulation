"""Component library — loaded from a declarative JSON file so the catalog
can grow without code changes (spec §4.1 / §5)."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from .schemas import ComponentDef

LIBRARY_PATH = Path(__file__).parent / "library" / "components.json"


@lru_cache(maxsize=1)
def load_library() -> list[ComponentDef]:
    raw = json.loads(LIBRARY_PATH.read_text(encoding="utf-8"))
    return [ComponentDef.model_validate(c) for c in raw["components"]]


def library_by_id() -> dict[str, ComponentDef]:
    return {c.id: c for c in load_library()}

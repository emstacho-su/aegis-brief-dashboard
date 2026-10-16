"""Brief validation (JSON Schema Draft 2020-12) and typed Pydantic models.

``validate_brief`` fails closed: any schema problem raises :class:`BriefValidationError`
listing the first five problems. ``parse_brief`` validates and then returns a
:class:`Brief` with the same defaults the web app applies when it normalizes real data
(missing lists become empty, empty ``areas`` becomes ``['other']``, and so on).
"""

from __future__ import annotations

import datetime as dt
import re
from functools import lru_cache
from typing import Any

from jsonschema import Draft202012Validator
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .shared import load_shared

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_PROBLEMS = 5


class BriefValidationError(ValueError):
    """Raised when a brief does not conform to ``packages/brief.schema.json``."""

    def __init__(self, problems: list[str], total: int) -> None:
        self.problems = problems
        self.total = total
        more = f" (+{total - len(problems)} more)" if total > len(problems) else ""
        super().__init__(f"brief failed schema validation{more}: " + "; ".join(problems))


def is_valid_date(value: str) -> bool:
    """True when ``value`` is a real calendar date in ``YYYY-MM-DD`` form."""
    if not isinstance(value, str) or not DATE_RE.match(value):
        return False
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        return False
    return True


@lru_cache(maxsize=1)
def validator() -> Draft202012Validator:
    """Return the cached Draft 2020-12 validator for the shared brief schema."""
    schema = load_shared("brief.schema.json")
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def _where(path: Any) -> str:
    parts = "".join(f"[{p}]" if isinstance(p, int) else f".{p}" for p in path)
    return "$" + parts


def duplicate_item_id_problems(data: Any) -> list[str]:
    """Describe every ``items[].item_id`` that repeats; JSON Schema cannot express this."""
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    positions: dict[str, list[int]] = {}
    for idx, item in enumerate(items):
        item_id = item.get("item_id") if isinstance(item, dict) else None
        if isinstance(item_id, str):
            positions.setdefault(item_id, []).append(idx)
    return [
        f"$.items: duplicate item_id {item_id!r} at positions " + ", ".join(f"[{i}]" for i in at)
        for item_id, at in positions.items()
        if len(at) > 1
    ]


def validate_brief(data: Any) -> None:
    """Validate ``data`` against the brief schema; raise BriefValidationError on failure.

    Beyond the schema, the top-level ``date`` must be a real calendar date, because it
    becomes a directory name in the volume, and ``items[].item_id`` must be unique.
    """
    errors = sorted(validator().iter_errors(data), key=lambda e: (list(map(str, e.absolute_path)), e.message))
    problems = [f"{_where(e.absolute_path)}: {e.message}" for e in errors]
    if isinstance(data, dict) and isinstance(data.get("date"), str) and not is_valid_date(data["date"]):
        problems.append(f"$.date: {data['date']!r} is not a valid calendar date")
    problems.extend(duplicate_item_id_problems(data))
    if problems:
        raise BriefValidationError(problems[:MAX_PROBLEMS], len(problems))


# --------------------------------------------------------------------------- models


class _Model(BaseModel):
    model_config = ConfigDict(extra="allow")


class Source(_Model):
    name: str = ""
    url: str = ""
    retrieved: str = ""


class Escalation(_Model):
    required: bool = False
    to: str = ""
    note: str = ""


class Item(_Model):
    item_id: str
    kind: str
    areas: list[str] = Field(default_factory=lambda: ["other"])
    tier: int
    priority: str
    status: str
    continued_days: int = 0
    score: int
    score_parts: dict[str, float] = Field(default_factory=dict)
    tlp: str = "clear"
    identifiers: list[str] = Field(default_factory=list)
    title: str
    description: str = ""
    su_impact: str = ""
    delta: str = ""
    body: str = ""
    source: Source = Field(default_factory=Source)
    recommended_actions: list[str] = Field(default_factory=list)
    escalation: Escalation = Field(default_factory=Escalation)
    first_seen: str
    cve_published: str | None = None
    attack: list[str] = Field(default_factory=list)
    confidence: str = ""
    indicators: list[tuple[str, str]] = Field(default_factory=list)

    @field_validator("areas")
    @classmethod
    def _areas_default(cls, v: list[str]) -> list[str]:
        return v if v else ["other"]


class ExposureRow(_Model):
    item: str
    state: str
    state_text: str = ""
    basis: str = ""
    days: int | None = None
    standing: bool = False
    areas: list[str] = Field(default_factory=list)


class Action(_Model):
    action_id: str
    text: str
    origin: str
    raised: str
    days: int
    areas: list[str] = Field(default_factory=list)


class Bullet(_Model):
    t: str
    d: str
    s: str = ""


class WatchBullet(Bullet):
    since: str = ""
    trigger: str = ""


class Context(_Model):
    geopolitical: list[Bullet] | None = None
    ai_watch: list[Bullet] | None = None
    watchlist: list[WatchBullet] | None = None


class Banner(_Model):
    cls: str
    text: str


class Run(_Model):
    at: str
    model: str
    schema_: str = Field(alias="schema")
    valid: bool
    feeds_fresh: int | None = None
    feeds_total: int | None = None
    stale: list[str] = Field(default_factory=list)
    chunks: int = 0
    prior_chunks: int = 0

    model_config = ConfigDict(extra="allow", populate_by_name=True)


class Brief(_Model):
    date: str
    baseline_date: str | None = None
    items: list[Item]
    outstanding: list[Action] = Field(default_factory=list)
    exposure: list[ExposureRow] = Field(default_factory=list)
    context: Context = Field(default_factory=Context)
    notes: dict[str, str] = Field(default_factory=dict)
    banners: list[Banner] = Field(default_factory=list)
    threat_level: str = ""
    fm: dict[str, Any] = Field(default_factory=dict)
    run: Run


def parse_brief(data: Any, *, validate: bool = True) -> Brief:
    """Validate (unless ``validate=False``) and return a typed, defaulted :class:`Brief`."""
    if validate:
        validate_brief(data)
    return Brief.model_validate(data)

"""Archive index: lifecycles, events and daily aggregates (CONTRACT section 2).

This is the canonical implementation; ``buildIndex`` in ``apps/web/dashboard.html`` is the
JavaScript fallback and the test suite asserts both produce the same output on the sample
data. Event rules, event text strings and weights follow ``buildIndex`` exactly.

Lifecycle fields follow the contract: ``title`` and ``kind`` come from the latest
observation; ``areas`` and ``identifiers`` are the union across days in first-appearance
order; ``sources`` is the sorted unique list of source names.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict

from .jsonio import canonical_dumps
from .schema import Brief, parse_brief
from .shared import load_areas


class Lifecycle(BaseModel):
    """One item's history across the retained briefs."""

    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    kind: str
    areas: list[str]
    identifiers: list[str]
    sources: list[str]
    first_seen: str
    last_seen: str
    days: list[str]
    tiers: list[int]
    scores: list[int]
    pris: list[str]
    escDays: list[str]  # noqa: N815 - contract field name
    maxTier: int  # noqa: N815
    maxScore: int  # noqa: N815
    t1days: int
    resolved: bool


class Event(BaseModel):
    """A change between two consecutive retained briefs."""

    date: str
    type: str
    id: str
    areas: list[str]
    text: str
    w: int


class Daily(BaseModel):
    """Per-brief aggregates."""

    date: str
    items: int
    t1: int
    t2: int
    t3: int
    new: int
    dropped: int
    esc: int
    actions: int
    avgAge: float  # noqa: N815
    avgActionAge: float  # noqa: N815
    valid: bool
    byArea: dict[str, int]  # noqa: N815


class ArchiveIndex(BaseModel):
    """The derived archive index written to ``archive-index.json``."""

    generated_from: list[str]
    today: str | None
    life: dict[str, Lifecycle]
    events: list[Event]
    daily: list[Daily]

    def to_dict(self) -> dict[str, Any]:
        """Return a plain JSON-ready dict."""
        return self.model_dump()

    def to_json(self) -> str:
        """Return canonical JSON (sorted keys, floats rounded to 4 places)."""
        return canonical_dumps(self.to_dict())


def _date_key(d: str | dt.date) -> str:
    return d.isoformat() if isinstance(d, dt.date) else str(d)


def _as_brief(b: Brief | Mapping[str, Any]) -> Brief:
    return b if isinstance(b, Brief) else parse_brief(dict(b), validate=False)


def _mean(values: list[int]) -> float:
    if not values:
        return 0.0
    total = 0
    for v in values:  # left-to-right, matching Array.reduce
        total += v
    return total / len(values)


def _append_unique(dst: list[str], values: list[str]) -> None:
    for v in values:
        if v not in dst:
            dst.append(v)


def build_index(
    briefs: Mapping[str | dt.date, Brief | Mapping[str, Any]],
    areas: Mapping[str, Any] | None = None,
) -> ArchiveIndex:
    """Build the archive index over ``briefs`` (keyed by date), processed in ascending date order.

    ``areas`` is the taxonomy whose keys populate ``daily[].byArea``; it defaults to
    ``packages/areas.json``. Input briefs may be :class:`Brief` models or raw dicts (raw
    dicts are defaulted but not re-validated).
    """
    area_keys = list((areas if areas is not None else load_areas()).keys())
    dates = sorted(_date_key(k) for k in briefs)
    by_date = {_date_key(k): _as_brief(v) for k, v in briefs.items()}
    today = dates[-1] if dates else None

    life: dict[str, dict[str, Any]] = {}
    sources: dict[str, set[str]] = {}
    events: list[Event] = []
    daily: list[Daily] = []

    for d, ds in enumerate(dates):
        b = by_date[ds]
        prev = by_date[dates[d - 1]] if d > 0 else None
        pm = {i.item_id: i for i in (prev.items if prev else [])}
        day_events: list[Event] = []

        for it in b.items:
            lc = life.get(it.item_id)
            if lc is None:
                lc = life[it.item_id] = {
                    "id": it.item_id,
                    "title": it.title,
                    "kind": it.kind,
                    "areas": [],
                    "identifiers": [],
                    "first_seen": it.first_seen,
                    "last_seen": ds,
                    "days": [],
                    "tiers": [],
                    "scores": [],
                    "pris": [],
                    "escDays": [],
                    "maxTier": 3,
                    "maxScore": 0,
                    "t1days": 0,
                }
                sources[it.item_id] = set()
            lc["title"] = it.title
            lc["kind"] = it.kind
            _append_unique(lc["areas"], it.areas)
            _append_unique(lc["identifiers"], it.identifiers)
            sources[it.item_id].add(it.source.name)
            lc["last_seen"] = ds
            lc["days"].append(ds)
            lc["tiers"].append(it.tier)
            lc["scores"].append(it.score)
            lc["pris"].append(it.priority)
            if it.escalation.required:
                lc["escDays"].append(ds)
            lc["maxTier"] = min(lc["maxTier"], it.tier)
            lc["maxScore"] = max(lc["maxScore"], it.score)
            if it.tier == 1:
                lc["t1days"] += 1

            p = pm.get(it.item_id)
            if p is None:
                returned = len(lc["days"]) > 1
                verb = "returned to the brief" if returned else "entered the brief"
                day_events.append(
                    Event(
                        date=ds,
                        type="returned" if returned else "new",
                        id=it.item_id,
                        areas=list(it.areas),
                        text=f"{verb} at Tier {it.tier}, score {it.score}",
                        w=3 if it.tier == 1 else 1,
                    )
                )
            else:
                if it.tier < p.tier:
                    day_events.append(
                        Event(
                            date=ds,
                            type="promoted",
                            id=it.item_id,
                            areas=list(it.areas),
                            text=f"promoted Tier {p.tier} to Tier {it.tier}, score {p.score} to {it.score}",
                            w=3,
                        )
                    )
                elif it.tier > p.tier:
                    day_events.append(
                        Event(
                            date=ds,
                            type="demoted",
                            id=it.item_id,
                            areas=list(it.areas),
                            text=f"moved Tier {p.tier} to Tier {it.tier}",
                            w=1,
                        )
                    )
                elif abs(it.score - p.score) >= 15:
                    day_events.append(
                        Event(
                            date=ds,
                            type="score_jump",
                            id=it.item_id,
                            areas=list(it.areas),
                            text=f"score {p.score} to {it.score}",
                            w=2,
                        )
                    )
                if it.escalation.required and not p.escalation.required:
                    day_events.append(
                        Event(
                            date=ds,
                            type="escalated",
                            id=it.item_id,
                            areas=list(it.areas),
                            text=f"escalation added: {it.escalation.to}",
                            w=3,
                        )
                    )

        if prev is not None:
            cur = {i.item_id for i in b.items}
            for p in prev.items:
                if p.item_id not in cur:
                    n = len(life[p.item_id]["days"])
                    plural = "" if n == 1 else "s"
                    day_events.append(
                        Event(
                            date=ds,
                            type="dropped",
                            id=p.item_id,
                            areas=list(p.areas),
                            text=f"dropped from the brief after {n} day{plural} (last Tier {p.tier})",
                            w=1,
                        )
                    )
            pa = {a.action_id for a in prev.outstanding}
            ca = {a.action_id for a in b.outstanding}
            for a in b.outstanding:
                if a.action_id not in pa:
                    day_events.append(
                        Event(
                            date=ds,
                            type="action_raised",
                            id=a.origin,
                            areas=list(a.areas),
                            text=f"action raised: {a.text}",
                            w=2,
                        )
                    )
            for a in prev.outstanding:
                if a.action_id not in ca:
                    day_events.append(
                        Event(
                            date=ds,
                            type="action_closed",
                            id=a.origin,
                            areas=list(a.areas),
                            text=f"action closed after {a.days + 1}d: {a.text}",
                            w=2,
                        )
                    )

        events.extend(day_events)
        by_tier = {1: 0, 2: 0, 3: 0}
        for i in b.items:
            by_tier[i.tier] = by_tier.get(i.tier, 0) + 1
        daily.append(
            Daily(
                date=ds,
                items=len(b.items),
                t1=by_tier[1],
                t2=by_tier[2],
                t3=by_tier[3],
                new=sum(1 for i in b.items if i.status == "new"),
                dropped=sum(1 for e in day_events if e.type == "dropped"),
                esc=sum(1 for i in b.items if i.escalation.required),
                actions=len(b.outstanding),
                avgAge=_mean([i.continued_days + 1 for i in b.items]),
                avgActionAge=_mean([a.days + 1 for a in b.outstanding]),
                valid=b.run.valid,
                byArea={k: sum(1 for i in b.items if k in i.areas) for k in area_keys},
            )
        )

    lifecycles = {
        k: Lifecycle(**v, sources=sorted(sources[k]), resolved=v["last_seen"] != today)
        for k, v in life.items()
    }
    return ArchiveIndex(generated_from=dates, today=today, life=lifecycles, events=events, daily=daily)

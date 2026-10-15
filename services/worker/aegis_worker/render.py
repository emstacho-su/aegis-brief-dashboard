"""Deterministic static HTML rendering of one brief (the L2 brief view).

The page mirrors ``renderBrief`` / ``itemCard`` / ``exposureTable`` / ``contextCards`` /
``healthStrip`` in ``apps/web/dashboard.html`` and reuses its CSS tokens verbatim
(``templates/brief.css``). It needs no JavaScript: Tier 2/3 items and context bullets
disclose with ``<details>``.

Guarantees:

* Jinja2 autoescape is on; every string from the brief is escaped.
* Indicators are defanged (leading ``http`` to ``hxxp``, every ``.`` to ``[.]``) and never
  rendered as links. Source URLs with an ``http``/``https`` scheme are the only live links.
* No wall-clock time is read; the output depends only on the brief, the index and the area
  taxonomy, and every dict iteration is ordered explicitly. Same input, same bytes.

The page depends on the index (archive size, today marker, neighbouring dates, average
age), so the volume re-renders every retained brief after each ingest.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape
from markupsafe import Markup

from .index import ArchiveIndex
from .schema import Brief, Item, parse_brief
from .shared import load_areas

TEMPLATES = Path(__file__).resolve().parent / "templates"

TLP_LABEL = {
    "clear": "TLP:CLEAR",
    "green": "TLP:GREEN",
    "amber": "TLP:AMBER",
    "amber_strict": "TLP:AMBER+STRICT",
    "red": "TLP:RED",
}
TIER_NAME = {1: "Action required", 2: "Awareness", 3: "Informational"}
STATE_CLS = {
    "vulnerable": "sev-critical",
    "confirmed": "sev-high",
    "conflicted": "sev-medium",
    "mitigated": "sev-low",
    "unverified": "sev-unknown",
}
STATE_RANK = {"vulnerable": 0, "confirmed": 1, "conflicted": 2, "unverified": 3, "mitigated": 4}
NOTE_LABELS = {
    "feeds": "Intel feeds digest",
    "ioc": "IOC extract",
    "coverage": "Coverage & gaps",
    "vendor": "Vendor advisory pulse",
    "answers": "Answers written back",
    "filtered": "Filtered items",
    "expected": "Expected to develop",
}
_HTTP_RE = re.compile(r"^http", re.IGNORECASE)


def defang(value: Any) -> str:
    """Defang an indicator exactly like the web app: leading ``http`` -> ``hxxp``, ``.`` -> ``[.]``."""
    return _HTTP_RE.sub("hxxp", str(value), count=1).replace(".", "[.]")


def safe_url(url: str | None) -> str | None:
    """Return ``url`` when it is an absolute http(s) URL with a host, else ``None``."""
    if not url:
        return None
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        return None
    return url.strip()


def jsnum(v: Any) -> str:
    """Format a number the way JavaScript's ``String(n)`` would for typical values."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        if math.isfinite(v) and v == int(v) and abs(v) < 1e21:
            return str(int(v))
        return repr(v)
    return str(v)


def threat_cls(level: str) -> str:
    """Map a threat level to the priority colour class used by the web app."""
    return "critical" if level == "CRITICAL" else "high" if level == "HIGH" else "medium"


@lru_cache(maxsize=1)
def _env() -> Environment:
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES)),
        autoescape=select_autoescape(enabled_extensions=("html", "j2"), default=True),
        undefined=StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
        keep_trailing_newline=True,
    )
    env.filters["defang"] = defang
    env.filters["jsnum"] = jsnum
    env.globals.update(
        TLP_LABEL=TLP_LABEL,
        TIER_NAME=TIER_NAME,
        STATE_CLS=STATE_CLS,
        safe_url=safe_url,
        threat_cls=threat_cls,
    )
    return env


@lru_cache(maxsize=1)
def _css() -> Markup:
    # Static file shipped with the package; not user input.
    return Markup((TEMPLATES / "brief.css").read_text(encoding="utf-8"))  # noqa: S704


def _score_title(it: Item) -> str:
    parts = " ".join(f"{k}={jsnum(it.score_parts[k])}" for k in sorted(it.score_parts))
    return f"Score {it.score}/100" + (f" · {parts}" if parts else "")


def _rows(items: list[Item]) -> list[dict[str, Any]]:
    """Order items by score (stable) and insert tier bands like ``renderBrief``."""
    out: list[dict[str, Any]] = []
    last_tier = 0
    for it in sorted(items, key=lambda i: -i.score):
        if it.tier != last_tier:
            out.append({"band": it.tier, "out_of_order": it.tier < last_tier})
            last_tier = it.tier
        out.append({"item": it, "score_title": _score_title(it)})
    return out


def _notes(notes: Mapping[str, str]) -> list[tuple[str, str]]:
    known = [k for k in NOTE_LABELS if k in notes]
    rest = sorted(k for k in notes if k not in NOTE_LABELS)
    return [(NOTE_LABELS.get(k, k), notes[k]) for k in known + rest]


def _exposure(brief: Brief) -> list[Any]:
    return sorted(brief.exposure, key=lambda r: (STATE_RANK.get(r.state, 99), -(r.days or 0)))


def render_brief(
    brief: Brief | Mapping[str, Any],
    index: ArchiveIndex | None = None,
    areas: Mapping[str, Mapping[str, str]] | None = None,
) -> str:
    """Render one brief as a standalone HTML page and return it as a string.

    ``index`` supplies archive-wide facts (archive size, whether this is today's brief,
    neighbouring retained dates, average age); without it the page renders as if the brief
    were the only one retained. ``areas`` defaults to ``packages/areas.json``.
    """
    b = brief if isinstance(brief, Brief) else parse_brief(dict(brief))
    area_map = dict(areas if areas is not None else load_areas())
    dates = list(index.generated_from) if index else [b.date]
    today = index.today if index else b.date
    pos = dates.index(b.date) if b.date in dates else -1
    prev_date = dates[pos - 1] if pos > 0 else None
    next_date = dates[pos + 1] if 0 <= pos < len(dates) - 1 else None
    daily = {d.date: d for d in index.daily} if index else {}
    cur_daily = daily.get(b.date)
    prev_daily = daily.get(prev_date) if prev_date else None

    def area_name(k: str) -> str:
        a = area_map.get(k)
        return a["name"] if a else k

    t1 = sum(1 for i in b.items if i.tier == 1)
    tiles = {
        "items": len(b.items),
        "items_delta": (len(b.items) - prev_daily.items) if prev_daily else None,
        "t1": t1,
        "t1_delta": (t1 - prev_daily.t1) if prev_daily else None,
        "t2": sum(1 for i in b.items if i.tier == 2),
        "t3": sum(1 for i in b.items if i.tier == 3),
        "new": sum(1 for i in b.items if i.status == "new"),
        "esc": sum(1 for i in b.items if i.escalation.required),
        "vulnerable": sum(1 for r in b.exposure if r.state == "vulnerable"),
        "avg_age": f"{(cur_daily.avgAge if cur_daily else _avg_age(b)):.1f}",
    }
    ctx = b.context
    context_cards = [
        ("Geopolitical & threat context", ctx.geopolitical, False),
        ("AI watch", ctx.ai_watch, False),
        ("Watchlist", ctx.watchlist, True),
    ]
    html = (
        _env()
        .get_template("brief.html.j2")
        .render(
            css=_css(),
            b=b,
            run=b.run,
            is_today=b.date == today,
            prev_date=prev_date,
            next_date=next_date,
            archive_days=len(dates),
            tiles=tiles,
            rows=_rows(b.items),
            exposure=_exposure(b),
            context_cards=context_cards,
            notes=_notes(b.notes),
            area_name=area_name,
        )
    )
    return html


def _avg_age(b: Brief) -> float:
    ages = [i.continued_days + 1 for i in b.items]
    return sum(ages) / len(ages) if ages else 0.0

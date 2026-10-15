"""Index tests: equality with the JavaScript buildIndex, plus unit checks of the event rules."""

from __future__ import annotations

import copy
import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
from conftest import DASHBOARD

from aegis_worker.index import build_index
from aegis_worker.jsonio import canonical_dumps
from aegis_worker.shared import load_areas

NODE = shutil.which("node")

HARNESS = r"""
const fs = require('fs');
const [srcPath, briefsPath, areasPath] = process.argv.slice(2);
const BRIEFS = JSON.parse(fs.readFileSync(briefsPath, 'utf8'));
const AREAS = JSON.parse(fs.readFileSync(areasPath, 'utf8'));
const HAS_REAL = true;
const DATES = Object.keys(BRIEFS).sort();
const TODAY = DATES.length - 1, TODAY_S = DATES[TODAY];
/* same normalization the page applies to real data before indexing */
Object.values(BRIEFS).forEach(b => { b.outstanding = b.outstanding || []; b.exposure = b.exposure || [];
  b.banners = b.banners || []; b.notes = b.notes || {};
  b.items.forEach(i => { i.attack = i.attack || []; i.indicators = i.indicators || [];
    i.recommended_actions = i.recommended_actions || []; i.identifiers = i.identifiers || [];
    i.areas = i.areas && i.areas.length ? i.areas : ['other'];
    i.escalation = i.escalation || {required: false, to: '', note: ''};
    i.source = i.source || {name: '', url: '', retrieved: ''}; i.score_parts = i.score_parts || {}; }); });
const src = fs.readFileSync(srcPath, 'utf8');
const run = new Function('BRIEFS', 'DATES', 'TODAY', 'TODAY_S', 'AREAS', 'HAS_REAL',
  src + '\nreturn buildIndex(BRIEFS, DATES, AREAS);');
const idx = run(BRIEFS, DATES, TODAY, TODAY_S, AREAS, HAS_REAL);
process.stdout.write(JSON.stringify(idx));
"""


def extract_function(source: str, name: str) -> str:
    """Return the source of ``function name(...) {...}`` using brace matching."""
    m = re.search(r"function\s+" + re.escape(name) + r"\s*\(", source)
    if not m:
        raise LookupError(f"function {name} not found")
    i = source.index("{", m.end())
    depth = 0
    quote: str | None = None
    j = i
    while j < len(source):
        c = source[j]
        if quote:
            if c == "\\":
                j += 2
                continue
            if c == quote:
                quote = None
        elif c in "'\"":
            quote = c
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return source[m.start() : j + 1]
        j += 1
    raise LookupError(f"unbalanced braces in {name}")


def normalize(obj: Any) -> Any:
    """Sorted keys and numbers compared as 4-decimal floats (JS has no int/float split)."""
    if isinstance(obj, bool) or obj is None or isinstance(obj, str):
        return obj
    if isinstance(obj, (int, float)):
        return round(float(obj), 4)
    if isinstance(obj, dict):
        return {k: normalize(obj[k]) for k in sorted(obj)}
    if isinstance(obj, list):
        return [normalize(v) for v in obj]
    raise TypeError(type(obj))


def run_js_index(samples: dict[str, Any], tmp_path: Path) -> dict[str, Any]:
    html = DASHBOARD.read_text(encoding="utf-8")
    src = extract_function(html, "buildIndex")
    (tmp_path / "buildIndex.js").write_text(src, encoding="utf-8")
    (tmp_path / "briefs.json").write_text(json.dumps(samples), encoding="utf-8")
    (tmp_path / "areas.json").write_text(json.dumps(load_areas()), encoding="utf-8")
    (tmp_path / "harness.js").write_text(HARNESS, encoding="utf-8")
    out = subprocess.run(
        [
            NODE,
            str(tmp_path / "harness.js"),
            str(tmp_path / "buildIndex.js"),
            str(tmp_path / "briefs.json"),
            str(tmp_path / "areas.json"),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert out.returncode == 0, out.stderr
    js = json.loads(out.stdout)
    dates = sorted(samples)
    js.setdefault("generated_from", dates)  # top-level fields the JS fallback may not emit
    js.setdefault("today", dates[-1])
    return js


@pytest.mark.skipif(NODE is None, reason="node not installed")
@pytest.mark.skipif(not DASHBOARD.is_file(), reason="apps/web/dashboard.html missing")
def test_index_matches_javascript_build_index(samples, tmp_path):
    py = normalize(json.loads(build_index(samples).to_json()))
    js = normalize(run_js_index(copy.deepcopy(samples), tmp_path))

    assert py["generated_from"] == js["generated_from"]
    assert py["today"] == js["today"]
    assert sorted(py["life"]) == sorted(js["life"])
    life_diffs = {
        k: {
            f: (py["life"][k].get(f), js["life"][k].get(f))
            for f in sorted(set(py["life"][k]) | set(js["life"][k]))
            if py["life"][k].get(f) != js["life"][k].get(f)
        }
        for k in py["life"]
        if py["life"][k] != js["life"][k]
    }
    fields = sorted({f for d in life_diffs.values() for f in d})
    assert not life_diffs, f"{len(life_diffs)} lifecycles differ in fields {fields}; first: " + json.dumps(
        next(iter(life_diffs.items()))
    )
    assert len(py["events"]) == len(js["events"])
    for n, (a, b) in enumerate(zip(py["events"], js["events"], strict=True)):
        assert a == b, f"event {n} differs: py={a} js={b}"
    for a, b in zip(py["daily"], js["daily"], strict=True):
        assert a == b, f"daily {a['date']} differs"
    assert py == js


def test_index_is_deterministic_and_canonical(samples):
    a = build_index(samples).to_json()
    b = build_index(dict(reversed(list(samples.items())))).to_json()
    assert a == b
    data = json.loads(a)
    assert list(data) == sorted(data)
    assert data["generated_from"] == sorted(samples)
    assert data["today"] == "2026-09-29"
    for d in data["daily"]:
        assert d["avgAge"] == round(d["avgAge"], 4)
        assert set(d["byArea"]) == set(load_areas())
    for lc in data["life"].values():
        assert lc["sources"] == sorted(set(lc["sources"]))
        assert lc["resolved"] == (lc["last_seen"] != "2026-09-29")


def _item(iid: str, tier: int = 2, score: int = 50, **kw: Any) -> dict[str, Any]:
    it = {
        "item_id": iid,
        "kind": "cve",
        "areas": ["identity"],
        "tier": tier,
        "priority": "high",
        "status": "new",
        "continued_days": 0,
        "score": score,
        "tlp": "clear",
        "identifiers": [],
        "title": iid,
        "description": "",
        "source": {"name": "S"},
        "escalation": {"required": False},
        "first_seen": "2026-01-01",
    }
    it.update(kw)
    return it


def _brief(date: str, items: list[dict[str, Any]], outstanding: list[dict[str, Any]] | None = None):
    return {
        "date": date,
        "items": items,
        "outstanding": outstanding or [],
        "exposure": [],
        "context": {},
        "run": {"at": date, "model": "m", "schema": "v1", "valid": True},
    }


def test_event_rules_and_lifecycle_contract_fields():
    act = {
        "action_id": "a1",
        "text": "patch",
        "origin": "x",
        "raised": "2026-01-01",
        "days": 0,
        "areas": ["identity"],
    }
    briefs = {
        "2026-01-01": _brief(
            "2026-01-01", [_item("x", 2, 50, source={"name": "Zed"}), _item("y", 3, 20)], [act]
        ),
        "2026-01-02": _brief(
            "2026-01-02",
            [
                _item(
                    "x",
                    1,
                    80,
                    title="x renamed",
                    areas=["cloud"],
                    identifiers=["CVE-1"],
                    source={"name": "Alpha"},
                    escalation={"required": True, "to": "CISO"},
                ),
            ],
            [dict(act, days=1)],
        ),
        "2026-01-03": _brief(
            "2026-01-03", [_item("x", 1, 60, areas=["identity"], title="x final"), _item("y", 3, 20)]
        ),
    }
    idx = build_index(briefs)
    types = [(e.date, e.type, e.id, e.w) for e in idx.events]
    assert types == [
        ("2026-01-01", "new", "x", 1),
        ("2026-01-01", "new", "y", 1),
        ("2026-01-02", "promoted", "x", 3),
        ("2026-01-02", "escalated", "x", 3),
        ("2026-01-02", "dropped", "y", 1),
        ("2026-01-03", "score_jump", "x", 2),
        ("2026-01-03", "returned", "y", 1),
        ("2026-01-03", "action_closed", "x", 2),
    ]
    texts = {e.type: e.text for e in idx.events}
    assert texts["promoted"] == "promoted Tier 2 to Tier 1, score 50 to 80"
    assert texts["escalated"] == "escalation added: CISO"
    assert texts["dropped"] == "dropped from the brief after 1 day (last Tier 3)"
    assert texts["action_closed"] == "action closed after 2d: patch"
    x = idx.life["x"]
    assert x.title == "x final"  # latest observation, not the first
    assert x.areas == ["identity", "cloud"] and x.identifiers == ["CVE-1"]
    assert x.sources == ["Alpha", "S", "Zed"]
    assert (x.maxTier, x.maxScore, x.t1days, x.escDays) == (1, 80, 2, ["2026-01-02"])
    assert idx.life["y"].days == ["2026-01-01", "2026-01-03"] and not idx.life["y"].resolved
    assert [d.dropped for d in idx.daily] == [0, 1, 0]
    assert idx.daily[1].avgActionAge == 2.0


def test_empty_index():
    idx = build_index({})
    assert idx.to_dict() == {"generated_from": [], "today": None, "life": {}, "events": [], "daily": []}
    assert canonical_dumps(idx.to_dict()).endswith("\n")

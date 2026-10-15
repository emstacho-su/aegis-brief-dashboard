#!/usr/bin/env python3
"""Make a new brief by copying the newest one to a later date.

Use it to exercise ingest end to end with a date the volume has not seen.
The source is the newest brief in --src or --out, so running it again
advances one more day. The copy is plausible, not realistic: every item
becomes "continued" and one day older, ages on actions and exposure rows go
up by the gap in days, and baseline_date points at the source brief.

    python3 scripts/new_brief.py                       # next day after the newest sample
    python3 scripts/new_brief.py --date 2026-10-02
    python3 scripts/new_brief.py --src data/briefs --out data/inbox

Output goes to data/inbox/ by default (git-ignored) so the 22 committed
samples stay unchanged. Then ingest it with one of:

    aegis-worker ingest data/inbox/<date>.json                    # local, scripts/dev.sh venv
    curl -fsS -X POST -H 'content-type: application/json' \\
         --data-binary @data/inbox/<date>.json http://localhost:8080/api/ingest
    scripts/replay.sh 1 data/inbox                                # container replay
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def newest(*dirs: Path) -> Path:
    files = [p for d in dirs if d.is_dir() for p in d.glob("*.json") if DATE_RE.match(p.stem)]
    if not files:
        sys.exit(f"new_brief: no YYYY-MM-DD.json files in {', '.join(map(str, dirs))}")
    return max(files, key=lambda p: p.stem)


def main() -> None:
    ap = argparse.ArgumentParser(description="Copy the newest brief to a new date.")
    ap.add_argument("--src", type=Path, default=REPO / "data" / "briefs")
    ap.add_argument("--out", type=Path, default=REPO / "data" / "inbox")
    ap.add_argument("--date", help="new date YYYY-MM-DD (default: the day after the newest source brief)")
    ap.add_argument("--force", action="store_true", help="overwrite an existing output file")
    args = ap.parse_args()

    # Newest across the source and the output dir, so repeated runs advance a day at a time.
    src_path = newest(args.src, args.out)
    brief = json.loads(src_path.read_text(encoding="utf-8"))
    old = dt.date.fromisoformat(brief["date"])
    new = dt.date.fromisoformat(args.date) if args.date else old + dt.timedelta(days=1)
    if new <= old:
        sys.exit(f"new_brief: --date {new} must be after the source date {old}")
    gap = (new - old).days

    out = copy.deepcopy(brief)
    out["date"] = new.isoformat()
    out["baseline_date"] = old.isoformat()

    for item in out.get("items", []):
        item["status"] = "continued"
        item["continued_days"] = int(item.get("continued_days") or 0) + gap
    for action in out.get("outstanding") or []:
        action["days"] = int(action.get("days") or 0) + gap
    for row in out.get("exposure") or []:
        if isinstance(row.get("days"), int):
            row["days"] += gap

    run = out.get("run")
    if isinstance(run, dict) and isinstance(run.get("at"), str):
        # Keep the producer's time of day, move the date.
        run["at"] = run["at"].replace(old.isoformat(), new.isoformat(), 1)

    args.out.mkdir(parents=True, exist_ok=True)
    dst = args.out / f"{new.isoformat()}.json"
    if dst.exists() and not args.force:
        sys.exit(f"new_brief: {dst} exists (use --force)")
    dst.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    try:
        shown = dst.resolve().relative_to(REPO)
    except ValueError:
        shown = dst
    print(f"new_brief: {src_path.name} -> {shown} ({len(out.get('items', []))} items, +{gap} day(s))")


if __name__ == "__main__":
    main()

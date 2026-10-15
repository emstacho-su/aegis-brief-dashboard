#!/usr/bin/env python3
"""Validate brief JSON files against packages/brief.schema.json.

    python3 scripts/validate_briefs.py                 # every file in data/briefs
    python3 scripts/validate_briefs.py path/a.json dir/

Also checks that each file is named after its own date. Exits 1 on any
failure. Needs jsonschema (pip install jsonschema).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import jsonschema

REPO = Path(__file__).resolve().parent.parent
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def targets(args: list[str]) -> list[Path]:
    paths = [Path(a) for a in args] or [REPO / "data" / "briefs"]
    out: list[Path] = []
    for p in paths:
        out.extend(sorted(p.glob("*.json")) if p.is_dir() else [p])
    return out


def main() -> int:
    schema = json.loads((REPO / "packages" / "brief.schema.json").read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema)
    files = targets(sys.argv[1:])
    if not files:
        print("validate_briefs: no files found", file=sys.stderr)
        return 1
    failed = 0
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"FAIL {f}: invalid JSON: {exc}")
            failed += 1
            continue
        errs = [f"{'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in validator.iter_errors(data)]
        if isinstance(data, dict) and DATE_RE.match(f.stem) and data.get("date") != f.stem:
            errs.append(f"date {data.get('date')!r} does not match file name")
        if errs:
            failed += 1
            print(f"FAIL {f}")
            for e in errs[:20]:
                print(f"  {e}")
        else:
            print(f"ok   {f.name}")
    print(f"validate_briefs: {len(files) - failed}/{len(files)} valid")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

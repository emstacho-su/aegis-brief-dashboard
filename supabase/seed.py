#!/usr/bin/env python3
"""Load raw brief rows into Supabase (fallback path).

CANONICAL PATH
    The worker is the canonical way to fill Supabase. It validates, renders,
    builds the archive index, prunes to MAX_BRIEFS, and then syncs all three
    (briefs rows, rendered HTML in the rendered-briefs bucket, archive_index):

        SYNC_TO_SUPABASE=1 SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \\
            aegis-worker ingest-dir data/briefs

THIS SCRIPT
    A fallback for when the worker is not installed. It only upserts the raw
    `briefs` rows. It does not render, build the index, or upload HTML. In
    static mode the web app can rebuild the index itself from the briefs rows
    (buildIndex fallback), so this is enough to get a Vercel deployment showing
    data. Optionally pass --index to upload an archive-index.json the worker
    already produced (for example ./volume/archive-index.json).

USAGE
    export SUPABASE_URL=https://<project>.supabase.co
    export SUPABASE_SERVICE_KEY=<service role or sb_secret_ key>
    python3 supabase/seed.py                     # load data/briefs
    python3 supabase/seed.py --dir path/to/briefs --max 30
    python3 supabase/seed.py --index volume/archive-index.json
    python3 supabase/seed.py --dry-run           # validate and list, no network
    python3 supabase/seed.py --prune             # also delete rows older than the oldest loaded date

    Requires: httpx. Uses jsonschema to validate against
    packages/brief.schema.json when it is installed; otherwise runs a minimal
    structural check and says so.

The key is read from the environment only and is never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_DIR = REPO / "data" / "briefs"
SCHEMA_PATH = REPO / "packages" / "brief.schema.json"
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
REQUIRED_TOP = ("date", "items", "exposure", "context", "run")


def die(msg: str, code: int = 1) -> None:
    print(f"seed: {msg}", file=sys.stderr)
    sys.exit(code)


def load_validator():
    try:
        import jsonschema  # type: ignore
    except ImportError:
        return None
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return jsonschema.Draft202012Validator(schema)


def check_brief(path: Path, data: object, validator) -> list[str]:
    errors: list[str] = []
    if not isinstance(data, dict):
        return ["top level is not an object"]
    if validator is not None:
        for err in sorted(validator.iter_errors(data), key=lambda e: list(e.path)):
            loc = "/".join(str(p) for p in err.path) or "(root)"
            errors.append(f"{loc}: {err.message}")
    else:
        for key in REQUIRED_TOP:
            if key not in data:
                errors.append(f"missing required field '{key}'")
    date = data.get("date")
    if not isinstance(date, str) or not DATE_RE.match(date):
        errors.append("date is not YYYY-MM-DD")
    elif path.stem != date:
        errors.append(f"file name {path.name} does not match date {date}")
    return errors


def collect(directory: Path, limit: int, validator) -> list[tuple[str, dict]]:
    files = sorted(p for p in directory.glob("*.json") if DATE_RE.match(p.stem))
    if not files:
        die(f"no YYYY-MM-DD.json files in {directory}")
    rows: list[tuple[str, dict]] = []
    bad = 0
    for path in files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"  REJECT {path.name}: invalid JSON ({exc})", file=sys.stderr)
            bad += 1
            continue
        errors = check_brief(path, data, validator)
        if errors:
            bad += 1
            print(f"  REJECT {path.name}:", file=sys.stderr)
            for e in errors[:10]:
                print(f"    {e}", file=sys.stderr)
            continue
        rows.append((data["date"], data))
    if bad:
        die(f"{bad} brief(s) failed validation; nothing was uploaded (fail closed)")
    # Retention mirrors the worker: keep the most recent `limit` dates.
    return rows[-limit:] if limit > 0 else rows


def headers(key: str) -> dict[str, str]:
    h = {"apikey": key, "Content-Type": "application/json"}
    # Legacy keys are JWTs and go in Authorization too. New sb_secret_ keys
    # are not JWTs; the API gateway takes them from the apikey header alone.
    if key.startswith("eyJ"):
        h["Authorization"] = f"Bearer {key}"
    return h


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Fallback loader: upsert raw brief rows into Supabase. "
        "Canonical path: SYNC_TO_SUPABASE=1 aegis-worker ingest-dir data/briefs",
    )
    ap.add_argument("--dir", type=Path, default=DEFAULT_DIR, help="directory of YYYY-MM-DD.json briefs")
    ap.add_argument(
        "--max",
        type=int,
        default=int(os.environ.get("MAX_BRIEFS", "30")),
        help="load only the N most recent dates (default MAX_BRIEFS or 30; 0 = all)",
    )
    ap.add_argument("--index", type=Path, help="optional archive-index.json produced by the worker")
    ap.add_argument("--batch", type=int, default=5, help="rows per request (default 5)")
    ap.add_argument("--prune", action="store_true", help="delete briefs rows older than the oldest loaded date")
    ap.add_argument("--dry-run", action="store_true", help="validate and list only; no network calls")
    args = ap.parse_args()

    validator = load_validator()
    if validator is None:
        print("seed: jsonschema not installed; running minimal checks only", file=sys.stderr)

    rows = collect(args.dir, args.max, validator)
    print(f"seed: {len(rows)} brief(s) ready, {rows[0][0]} .. {rows[-1][0]}")

    index_data = None
    if args.index:
        try:
            index_data = json.loads(args.index.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            die(f"cannot read --index file: {exc}")
        if not isinstance(index_data, dict) or "life" not in index_data:
            die("--index file does not look like an archive index (no 'life' key)")

    if args.dry_run:
        for date, _ in rows:
            print(f"  would upsert briefs[{date}]")
        if index_data is not None:
            print("  would upsert archive_index[1]")
        if args.prune:
            print(f"  would delete briefs rows with date < {rows[0][0]}")
        return

    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        die("set SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment (see --help)", 2)
    if not url.startswith(("https://", "http://localhost", "http://127.0.0.1")):
        die("SUPABASE_URL must be https (or a local http://localhost stack)", 2)

    try:
        import httpx
    except ImportError:
        die("httpx is required: pip install httpx", 2)

    rest = f"{url}/rest/v1"
    upsert = {**headers(key), "Prefer": "resolution=merge-duplicates,return=minimal"}

    with httpx.Client(timeout=60) as client:
        for i in range(0, len(rows), max(1, args.batch)):
            chunk = rows[i : i + args.batch]
            payload = [{"date": d, "data": b} for d, b in chunk]
            r = client.post(f"{rest}/briefs", params={"on_conflict": "date"}, headers=upsert, json=payload)
            if r.status_code >= 300:
                die(f"upsert failed for {chunk[0][0]}..{chunk[-1][0]}: HTTP {r.status_code} {r.text[:300]}")
            for d, _ in chunk:
                print(f"  upserted briefs[{d}]")

        if index_data is not None:
            r = client.post(
                f"{rest}/archive_index",
                params={"on_conflict": "id"},
                headers=upsert,
                json=[{"id": 1, "data": index_data}],
            )
            if r.status_code >= 300:
                die(f"archive_index upsert failed: HTTP {r.status_code} {r.text[:300]}")
            print("  upserted archive_index[1]")

        if args.prune:
            oldest = rows[0][0]
            r = client.delete(
                f"{rest}/briefs",
                params={"date": f"lt.{oldest}"},
                headers={**headers(key), "Prefer": "return=representation"},
            )
            if r.status_code >= 300:
                die(f"prune failed: HTTP {r.status_code} {r.text[:300]}")
            print(f"  pruned {len(r.json())} row(s) older than {oldest}")

    print("seed: done")
    if index_data is None:
        print("seed: archive_index was not touched; the web app rebuilds it from briefs, "
              "or run the worker with SYNC_TO_SUPABASE=1 for the canonical index.")


if __name__ == "__main__":
    main()

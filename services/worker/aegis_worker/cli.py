"""Command line entry point ``aegis-worker``.

Commands::

    aegis-worker ingest <file.json>
    aegis-worker ingest-dir <dir> [--if-empty]
    aegis-worker rebuild
    aegis-worker replay <dir> [--step]
    aegis-worker serve [--host 0.0.0.0] [--port $PORT]

Settings come from the environment (``VOLUME_ROOT``, ``MAX_BRIEFS``, ``PORT``, ...).
Exit codes: 0 ok, 1 validation or input error, 2 usage error.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

from . import sync as sync_mod
from .jsonio import read_json
from .schema import BriefValidationError, is_valid_date
from .settings import Settings
from .volume import Volume

log = logging.getLogger("aegis_worker")


def _volume(settings: Settings) -> Volume:
    return Volume(settings.volume_root, settings.max_briefs, sync_hook=sync_mod.hook_from_env())


def _brief_files(directory: Path) -> list[tuple[str, Path]]:
    """Return (brief date, path) for every ``*.json`` brief in ``directory``, sorted by date."""
    if not directory.is_dir():
        raise FileNotFoundError(f"not a directory: {directory}")
    out = []
    for p in sorted(directory.glob("*.json")):
        data = read_json(p)
        date = data.get("date") if isinstance(data, dict) else None
        if not isinstance(date, str) or not is_valid_date(date):
            raise ValueError(f"{p}: missing or invalid 'date'")
        out.append((date, p))
    out.sort(key=lambda t: (t[0], t[1].name))
    return out


def _emit(obj: Any) -> None:
    print(json.dumps(obj, sort_keys=True))


def cmd_ingest(args: argparse.Namespace, settings: Settings) -> int:
    manifest = _volume(settings).ingest(Path(args.file))
    print(f"ingested {manifest['last_ingest']} from {args.file}; retained {len(manifest['retained'])}")
    _emit(manifest)
    return 0


def cmd_ingest_dir(args: argparse.Namespace, settings: Settings) -> int:
    vol = _volume(settings)
    if args.if_empty and not vol.is_empty():
        print(f"volume {vol.root} already holds {len(vol.dates())} briefs; skipping seed")
        return 0
    files = _brief_files(Path(args.dir))
    if not files:
        print(f"no *.json briefs in {args.dir}")
        return 0
    result = vol.ingest_many([p for _, p in files])
    print(
        f"ingested {len(result.ingested)} briefs ({result.ingested[0]} to {result.ingested[-1]}); "
        f"retained {len(result.manifest['retained'])}, pruned {len(result.pruned)}"
    )
    _emit(result.manifest)
    return 0


def cmd_rebuild(args: argparse.Namespace, settings: Settings) -> int:
    manifest = _volume(settings).rebuild()
    print(f"rebuilt index and pages for {len(manifest['retained'])} briefs")
    _emit(manifest)
    return 0


def cmd_replay(args: argparse.Namespace, settings: Settings) -> int:
    """Ingest briefs from ``dir`` in date order, skipping dates already retained.

    Dates older than the oldest retained date are skipped once the volume is full, since
    they would be pruned immediately. With ``--step`` only the next one is ingested.
    """
    vol = _volume(settings)
    retained = set(vol.dates())
    full = len(retained) >= vol.max_briefs
    oldest = min(retained) if retained else None
    pending = [
        (d, p)
        for d, p in _brief_files(Path(args.dir))
        if d not in retained and not (full and oldest is not None and d < oldest)
    ]
    if not pending:
        print(f"replay: nothing to do; all briefs in {args.dir} are already in the volume")
        return 0
    batch = pending[:1] if args.step else pending
    for n, (date, path) in enumerate(batch, start=1):
        manifest = vol.ingest(path)
        kept = manifest["retained"]
        span = f"{kept[0]} to {kept[-1]}" if kept else "empty"
        print(
            f"replay: ingested {date} from {path.name}; retained {len(kept)} ({span}); "
            f"{len(pending) - n} remaining"
        )
    return 0


def cmd_serve(args: argparse.Namespace, settings: Settings) -> int:
    import uvicorn

    from .api import create_app

    app = create_app(settings)
    port = args.port or settings.port
    log.info(
        "serving on %s:%s (volume %s, web root %s)", args.host, port, settings.volume_root, settings.web_root
    )
    uvicorn.run(
        app,
        host=args.host,
        port=port,
        proxy_headers=True,
        log_level=args.log_level.lower(),
        server_header=False,
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    """Return the argparse parser."""
    p = argparse.ArgumentParser(prog="aegis-worker", description="AEGIS daily brief worker")
    p.add_argument(
        "--log-level",
        default=os.environ.get("LOG_LEVEL", "INFO"),
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("ingest", help="validate and ingest one brief JSON file")
    s.add_argument("file")
    s.set_defaults(func=cmd_ingest)
    s = sub.add_parser("ingest-dir", help="ingest every *.json brief in a directory, in date order")
    s.add_argument("dir")
    s.add_argument("--if-empty", action="store_true", help="do nothing when the volume already has briefs")
    s.set_defaults(func=cmd_ingest_dir)
    s = sub.add_parser("rebuild", help="re-prune, re-index and re-render the volume")
    s.set_defaults(func=cmd_rebuild)
    s = sub.add_parser("replay", help="simulate daily arrival from a directory of briefs")
    s.add_argument("dir")
    s.add_argument("--step", action="store_true", help="ingest only the next brief not yet in the volume")
    s.set_defaults(func=cmd_replay)
    s = sub.add_parser("serve", help="run the HTTP API and dashboard")
    s.add_argument("--host", default="0.0.0.0")  # noqa: S104 - container service
    s.add_argument("--port", type=int, default=None, help="defaults to $PORT or 8080")
    s.set_defaults(func=cmd_serve)
    return p


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=args.log_level, stream=sys.stderr, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    settings = Settings.from_env()
    try:
        return int(args.func(args, settings))
    except BriefValidationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        for prob in exc.problems:
            print(f"  - {prob}", file=sys.stderr)
        return 1
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:  # stdout closed early (e.g. piped into head)
        sys.stdout = open(os.devnull, "w")  # noqa: SIM115 - silence the flush at exit
        return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())

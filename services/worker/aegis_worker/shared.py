"""Locate the shared contract files (``brief.schema.json`` and ``areas.json``).

Resolution order, first hit wins:

1. ``AEGIS_PACKAGES_DIR`` environment variable (a directory holding both files).
2. The repository's ``packages/`` directory, when running from a checkout
   (``services/worker/aegis_worker/../../../packages``).
3. The copies bundled inside the installed package at ``aegis_worker/_shared/``.
   The Dockerfile copies them there before ``pip install``; locally run
   ``python -m aegis_worker.shared --sync`` before building a wheel.

The files are never edited here; ``packages/`` in the repo is the single source.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from functools import cache
from pathlib import Path
from typing import Any

SHARED_FILES = ("brief.schema.json", "areas.json")
_PKG_DIR = Path(__file__).resolve().parent
_BUNDLED = _PKG_DIR / "_shared"
_REPO_PACKAGES = _PKG_DIR.parent.parent.parent / "packages"


def candidate_dirs() -> list[Path]:
    """Return the directories searched for shared files, in priority order."""
    dirs: list[Path] = []
    env = os.environ.get("AEGIS_PACKAGES_DIR")
    if env:
        dirs.append(Path(env))
    dirs.extend([_REPO_PACKAGES, _BUNDLED])
    return dirs


def shared_path(name: str) -> Path:
    """Return the path of a shared file, raising FileNotFoundError when none is found."""
    for d in candidate_dirs():
        p = d / name
        if p.is_file():
            return p
    searched = ", ".join(str(d) for d in candidate_dirs())
    raise FileNotFoundError(f"{name} not found; searched {searched}")


@cache
def load_shared(name: str) -> Any:
    """Load and cache a shared JSON file by name."""
    with shared_path(name).open(encoding="utf-8") as fh:
        return json.load(fh)


def load_areas() -> dict[str, dict[str, str]]:
    """Return the area taxonomy (key -> {name, desc}) in file order."""
    return dict(load_shared("areas.json"))


def sync_bundled(src: Path = _REPO_PACKAGES) -> list[Path]:
    """Copy the repo's shared files into ``aegis_worker/_shared`` (build-time step)."""
    _BUNDLED.mkdir(exist_ok=True)
    out = []
    for name in SHARED_FILES:
        dst = _BUNDLED / name
        shutil.copyfile(src / name, dst)
        out.append(dst)
    return out


if __name__ == "__main__":  # pragma: no cover - build helper
    if "--sync" in sys.argv:
        for p in sync_bundled():
            sys.stdout.write(f"synced {p}\n")
    else:
        for n in SHARED_FILES:
            sys.stdout.write(f"{n}: {shared_path(n)}\n")

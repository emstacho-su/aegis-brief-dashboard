"""Canonical JSON serialization and atomic file writes.

Every JSON file the worker writes goes through :func:`canonical_dumps`: sorted keys,
floats rounded to 4 places (integral floats stay floats, e.g. ``20.0``), UTF-8, two-space
indent and a trailing newline. Same input, same bytes.
"""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

FLOAT_PLACES = 4


def normalize(obj: Any) -> Any:
    """Return a copy of ``obj`` with floats rounded and tuples turned into lists."""
    if isinstance(obj, bool) or obj is None or isinstance(obj, (int, str)):
        return obj
    if isinstance(obj, float):
        r = round(obj, FLOAT_PLACES)
        return 0.0 if r == 0 else r  # fold -0.0
    if isinstance(obj, dict):
        return {str(k): normalize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [normalize(v) for v in obj]
    raise TypeError(f"not JSON serializable: {type(obj).__name__}")


def canonical_dumps(obj: Any) -> str:
    """Serialize ``obj`` deterministically (sorted keys, rounded floats, newline-terminated)."""
    return json.dumps(normalize(obj), sort_keys=True, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def canonicalize(obj: Any) -> Any:
    """Round-trip ``obj`` through canonical JSON so dict order and floats are canonical."""
    return json.loads(canonical_dumps(obj))


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write ``data`` to ``path`` via a temp file in the same directory and ``os.replace``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp)
        raise


def write_if_changed(path: Path, text: str) -> bool:
    """Atomically write ``text`` (UTF-8) unless the file already holds exactly these bytes."""
    data = text.encode("utf-8")
    try:
        if path.read_bytes() == data:
            return False
    except FileNotFoundError:
        pass
    atomic_write_bytes(path, data)
    return True


def read_json(path: Path) -> Any:
    """Read a UTF-8 JSON file."""
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)

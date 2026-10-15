"""The rotating brief volume (CONTRACT section 3).

Layout::

    VOLUME_ROOT/
      briefs/YYYY-MM-DD/brief.json     canonical copy of the validated input
      briefs/YYYY-MM-DD/index.html     deterministic render of the brief
      archive-index.json               rebuilt after every ingest and prune
      manifest.json                    {retained, max_briefs, last_ingest}

The volume's derived state is a pure function of the retained briefs: after every
ingest the worker prunes to the ``max_briefs`` most recent dates, rebuilds the index and
re-renders every retained brief (only files whose bytes change are rewritten). So
``ingest-dir`` and ``rebuild`` produce the same bytes. Writes are atomic (temp file then
``os.replace``) and a file lock on ``VOLUME_ROOT/.lock`` serializes writers across
processes.
"""

from __future__ import annotations

import contextlib
import fcntl
import logging
import os
import shutil
import threading
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .index import ArchiveIndex, build_index
from .jsonio import canonical_dumps, canonicalize, read_json, write_if_changed
from .render import render_brief
from .schema import Brief, is_valid_date, parse_brief
from .shared import load_areas

log = logging.getLogger(__name__)

DEFAULT_VOLUME_ROOT = "/var/lib/aegis/volume"
DEFAULT_MAX_BRIEFS = 30
_thread_lock = threading.Lock()

BriefSource = str | os.PathLike[str] | dict[str, Any]
SyncHook = Callable[["Volume", "IngestResult"], None]


@dataclass
class IngestResult:
    """What one ingest (or rebuild) changed; handed to the optional sync hook."""

    manifest: dict[str, Any]
    ingested: list[str] = field(default_factory=list)  # dates whose brief rows should be mirrored
    pruned: list[str] = field(default_factory=list)
    changed_html: list[str] = field(default_factory=list)
    index: ArchiveIndex | None = None


def load_source(src: BriefSource) -> dict[str, Any]:
    """Load a brief from a path or accept a dict; return a canonicalized dict."""
    data = src if isinstance(src, dict) else read_json(Path(src))
    if not isinstance(data, dict):
        raise ValueError("brief JSON must be an object")
    return canonicalize(data)


class Volume:
    """A brief volume rooted at ``root`` retaining at most ``max_briefs`` dates."""

    def __init__(
        self,
        root: str | os.PathLike[str],
        max_briefs: int = DEFAULT_MAX_BRIEFS,
        sync_hook: SyncHook | None = None,
    ) -> None:
        if max_briefs < 1:
            raise ValueError("max_briefs must be >= 1")
        self.root = Path(root)
        self.max_briefs = max_briefs
        self.sync_hook = sync_hook

    @classmethod
    def from_env(cls, sync_hook: SyncHook | None = None) -> Volume:
        """Build a Volume from ``VOLUME_ROOT`` and ``MAX_BRIEFS``."""
        return cls(
            os.environ.get("VOLUME_ROOT", DEFAULT_VOLUME_ROOT),
            int(os.environ.get("MAX_BRIEFS", DEFAULT_MAX_BRIEFS)),
            sync_hook=sync_hook,
        )

    # ------------------------------------------------------------------ paths
    @property
    def briefs_dir(self) -> Path:
        """Directory holding one subdirectory per retained date."""
        return self.root / "briefs"

    @property
    def index_path(self) -> Path:
        """Path of ``archive-index.json``."""
        return self.root / "archive-index.json"

    @property
    def manifest_path(self) -> Path:
        """Path of ``manifest.json``."""
        return self.root / "manifest.json"

    def brief_path(self, date: str) -> Path:
        """Path of a date's ``brief.json``; ``date`` must be a valid YYYY-MM-DD date."""
        return self._date_dir(date) / "brief.json"

    def html_path(self, date: str) -> Path:
        """Path of a date's rendered ``index.html``."""
        return self._date_dir(date) / "index.html"

    def _date_dir(self, date: str) -> Path:
        if not is_valid_date(date):
            raise ValueError(f"invalid date: {date!r}")
        return self.briefs_dir / date

    # ------------------------------------------------------------------ reads
    def dates(self) -> list[str]:
        """Dates with a stored ``brief.json``, ascending (scans the directory)."""
        if not self.briefs_dir.is_dir():
            return []
        return sorted(
            p.name
            for p in self.briefs_dir.iterdir()
            if p.is_dir() and is_valid_date(p.name) and (p / "brief.json").is_file()
        )

    def is_empty(self) -> bool:
        """True when no brief is stored."""
        return not self.dates()

    def read_brief(self, date: str) -> dict[str, Any] | None:
        """Return the stored brief JSON for ``date`` or None."""
        p = self.brief_path(date)
        return read_json(p) if p.is_file() else None

    def read_html(self, date: str) -> str | None:
        """Return the stored rendered HTML for ``date`` or None."""
        p = self.html_path(date)
        return p.read_text(encoding="utf-8") if p.is_file() else None

    def read_manifest(self) -> dict[str, Any]:
        """Return the manifest, or an empty one when none has been written."""
        if self.manifest_path.is_file():
            return read_json(self.manifest_path)
        return {"retained": [], "max_briefs": self.max_briefs, "last_ingest": None}

    def read_index(self) -> dict[str, Any]:
        """Return the stored archive index, or an empty index when none exists."""
        if self.index_path.is_file():
            return read_json(self.index_path)
        return build_index({}).to_dict()

    def read_all_briefs(self) -> dict[str, dict[str, Any]]:
        """Return every retained brief keyed by date."""
        out: dict[str, dict[str, Any]] = {}
        for d in self.dates():
            b = self.read_brief(d)
            if b is not None:
                out[d] = b
        return out

    # ------------------------------------------------------------------ writes
    @contextlib.contextmanager
    def locked(self) -> Iterator[None]:
        """Hold the in-process and cross-process writer lock."""
        self.root.mkdir(parents=True, exist_ok=True)
        with _thread_lock, open(self.root / ".lock", "a+") as fh:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

    def ingest(self, src: BriefSource) -> dict[str, Any]:
        """Validate, store, prune, re-index and re-render; return the manifest.

        Raises :class:`aegis_worker.schema.BriefValidationError` (nothing is written) when
        the brief fails validation. Re-ingesting an existing date replaces it in place.
        ``manifest.last_ingest`` is the ingested brief's date.
        """
        return self.ingest_many([src]).manifest

    def ingest_many(self, sources: Iterable[BriefSource]) -> IngestResult:
        """Ingest several briefs in ascending date order with one rebuild at the end.

        Every brief is validated before anything is written, so a bad file aborts the
        whole batch. The result is byte-identical to ingesting them one at a time.
        """
        loaded = [load_source(s) for s in sources]
        briefs = [(parse_brief(d), d) for d in loaded]  # validates; raises before any write
        briefs.sort(key=lambda t: t[0].date)
        if not briefs:
            raise ValueError("nothing to ingest")
        with self.locked():
            for model, data in briefs:
                write_if_changed(self.brief_path(model.date), canonical_dumps(data))
                log.info("stored brief %s", model.date)
            result = self._finalize(last_ingest=briefs[-1][0].date, validate_stored=False)
            result.ingested = [m.date for m, _ in briefs]
        self._sync(result)
        return result

    def rebuild(self) -> dict[str, Any]:
        """Re-prune, re-index and re-render from the stored briefs; return the manifest.

        The sync hook (if any) receives every retained date as ``ingested`` so a rebuild
        also re-mirrors all brief rows.
        """
        with self.locked():
            result = self._finalize(last_ingest=self.read_manifest().get("last_ingest"), validate_stored=True)
            result.ingested = list(result.manifest["retained"])
        self._sync(result)
        return result.manifest

    def _finalize(self, last_ingest: str | None, validate_stored: bool) -> IngestResult:
        """Prune, rebuild the index, re-render and write the manifest (lock held).

        Stored briefs were validated when ingested; ``validate_stored`` re-checks them
        (used by ``rebuild``, which may run over a hand-edited volume).
        """
        dates = self.dates()
        keep = dates[-self.max_briefs :]
        pruned = [d for d in dates if d not in keep]
        for d in pruned:
            shutil.rmtree(self.briefs_dir / d)
            log.info("pruned brief %s (retention %d)", d, self.max_briefs)
        if last_ingest in pruned:
            log.warning("ingested brief %s is older than the retention window and was pruned", last_ingest)

        models: dict[str, Brief] = {}
        for d in keep:
            data = read_json(self.brief_path(d))
            models[d] = parse_brief(data, validate=validate_stored)
        areas = load_areas()
        index = build_index(models, areas)
        write_if_changed(self.index_path, index.to_json())

        changed: list[str] = []
        for d in keep:
            if write_if_changed(self.html_path(d), render_brief(models[d], index, areas)):
                changed.append(d)
        manifest = {"retained": keep, "max_briefs": self.max_briefs, "last_ingest": last_ingest}
        write_if_changed(self.manifest_path, canonical_dumps(manifest))
        self._sweep_tmp()
        return IngestResult(manifest=manifest, pruned=pruned, changed_html=changed, index=index)

    def _sweep_tmp(self) -> None:
        """Remove temp files left behind by a crashed writer (we hold the lock)."""
        for p in [*self.root.glob(".tmp-*"), *self.briefs_dir.glob("*/.tmp-*")]:
            with contextlib.suppress(FileNotFoundError):
                p.unlink()

    def _sync(self, result: IngestResult) -> None:
        if self.sync_hook is None:
            return
        try:
            self.sync_hook(self, result)
        except Exception:  # sync is best effort; the volume is the source of truth
            log.exception("post-ingest sync failed")

"""Optional Supabase mirror (CONTRACT sections 4 and 6).

Enabled only when ``SYNC_TO_SUPABASE=1`` *and* ``SUPABASE_URL`` and
``SUPABASE_SERVICE_KEY`` are set; otherwise :func:`hook_from_env` returns ``None`` and
nothing happens. After each ingest or rebuild it:

* upserts ``briefs(date, data)`` for every ingested date,
* uploads ``rendered-briefs/<date>/index.html`` (upsert) for every page whose bytes changed
  (re-rendering touches older pages too, e.g. the "Today" marker and archive size),
* upserts ``archive_index(id=1, data)``,
* deletes ``briefs`` rows and rendered pages for dates pruned from the volume, so the
  mirror keeps the same retention window as the volume.

The service key is sent only in request headers and is never logged; log lines carry the
table or object path and the HTTP status only.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

import httpx

if TYPE_CHECKING:
    from .volume import IngestResult, Volume

log = logging.getLogger(__name__)

BUCKET = "rendered-briefs"


class SyncError(RuntimeError):
    """A Supabase request failed."""


@dataclass(frozen=True)
class SupabaseConfig:
    """Connection settings for the service-role client."""

    url: str
    service_key: str

    def __repr__(self) -> str:  # never expose the key
        return f"SupabaseConfig(url={self.url!r}, service_key='***')"


def config_from_env(env: dict[str, str] | None = None) -> SupabaseConfig | None:
    """Return the sync config when sync is enabled and fully configured, else None."""
    env = dict(os.environ if env is None else env)
    if env.get("SYNC_TO_SUPABASE", "0").strip() not in ("1", "true", "yes"):
        return None
    url = env.get("SUPABASE_URL", "").strip().rstrip("/")
    key = env.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        log.warning("SYNC_TO_SUPABASE=1 but SUPABASE_URL or SUPABASE_SERVICE_KEY is missing; sync disabled")
        return None
    return SupabaseConfig(url=url, service_key=key)


class SupabaseSync:
    """Minimal REST and Storage client for the worker's mirror writes."""

    def __init__(
        self, cfg: SupabaseConfig, transport: httpx.BaseTransport | None = None, timeout: float = 20.0
    ) -> None:
        self.cfg = cfg
        self._client = httpx.Client(
            base_url=cfg.url,
            headers={"apikey": cfg.service_key, "Authorization": f"Bearer {cfg.service_key}"},
            timeout=timeout,
            transport=transport,
        )

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def _check(self, resp: httpx.Response, what: str) -> None:
        if resp.status_code >= 300:
            log.error("supabase %s failed: HTTP %s", what, resp.status_code)
            raise SyncError(f"{what}: HTTP {resp.status_code}")
        log.info("supabase %s: HTTP %s", what, resp.status_code)

    def upsert_rows(self, table: str, rows: list[dict[str, Any]], on_conflict: str) -> None:
        """Upsert ``rows`` into ``table`` via PostgREST (merge duplicates)."""
        resp = self._client.post(
            f"/rest/v1/{table}",
            params={"on_conflict": on_conflict},
            json=rows,
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
        )
        self._check(resp, f"upsert {table} ({len(rows)} rows)")

    def delete_briefs(self, dates: list[str]) -> None:
        """Delete ``briefs`` rows for ``dates``."""
        resp = self._client.delete(
            "/rest/v1/briefs",
            params={"date": f"in.({','.join(dates)})"},
            headers={"Prefer": "return=minimal"},
        )
        self._check(resp, f"delete briefs ({len(dates)} rows)")

    def upload_html(self, date: str, html: str) -> None:
        """Upload (upsert) a rendered page to ``rendered-briefs/<date>/index.html``."""
        path = f"{quote(date)}/index.html"
        resp = self._client.post(
            f"/storage/v1/object/{BUCKET}/{path}",
            content=html.encode("utf-8"),
            headers={
                "Content-Type": "text/html; charset=utf-8",
                "x-upsert": "true",
                "Cache-Control": "no-cache",
            },
        )
        self._check(resp, f"upload {BUCKET}/{path}")

    def delete_html(self, dates: list[str]) -> None:
        """Remove rendered pages for ``dates`` from the bucket."""
        resp = self._client.request(
            "DELETE",
            f"/storage/v1/object/{BUCKET}",
            json={"prefixes": [f"{d}/index.html" for d in dates]},
        )
        self._check(resp, f"delete {BUCKET} ({len(dates)} objects)")

    def push(self, volume: Volume, result: IngestResult) -> None:
        """Mirror one ingest/rebuild result to Supabase."""
        rows = []
        for d in result.ingested:
            data = volume.read_brief(d)
            if data is not None:
                rows.append({"date": d, "data": data})
        if rows:
            self.upsert_rows("briefs", rows, on_conflict="date")
        for d in result.changed_html:
            html = volume.read_html(d)
            if html is not None:
                self.upload_html(d, html)
        self.upsert_rows("archive_index", [{"id": 1, "data": volume.read_index()}], on_conflict="id")
        if result.pruned:
            self.delete_briefs(result.pruned)
            self.delete_html(result.pruned)


def hook_from_env(
    transport: httpx.BaseTransport | None = None,
) -> Callable[[Volume, IngestResult], None] | None:
    """Return a Volume sync hook when sync is configured, else None (no-op)."""
    cfg = config_from_env()
    if cfg is None:
        return None

    def hook(volume: Volume, result: IngestResult) -> None:
        client = SupabaseSync(cfg, transport=transport)
        try:
            client.push(volume, result)
        finally:
            client.close()

    return hook

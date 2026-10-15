from __future__ import annotations

import json
import logging

import httpx

from aegis_worker import sync
from aegis_worker.volume import Volume


def test_sync_is_noop_without_configuration(monkeypatch, volume_root, sample_dir):
    assert sync.hook_from_env() is None
    monkeypatch.setenv("SYNC_TO_SUPABASE", "1")  # enabled but not configured
    assert sync.hook_from_env() is None
    monkeypatch.setenv("SYNC_TO_SUPABASE", "0")
    monkeypatch.setenv("SUPABASE_URL", "https://p.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "service-secret")
    assert sync.hook_from_env() is None


def test_sync_pushes_rows_html_and_index(monkeypatch, volume_root, sample_dir, caplog):
    monkeypatch.setenv("SYNC_TO_SUPABASE", "1")
    monkeypatch.setenv("SUPABASE_URL", "https://p.supabase.co/")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "service-secret")
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.headers["apikey"] == "service-secret"
        assert req.headers["authorization"] == "Bearer service-secret"
        calls.append(
            (
                req.method,
                req.url.path,
                req.url.params.get("on_conflict") or req.url.params.get("date"),
                req.headers.get("x-upsert"),
                req.content,
            )
        )
        return httpx.Response(201 if req.method == "POST" else 200)

    hook = sync.hook_from_env(transport=httpx.MockTransport(handler))
    vol = Volume(volume_root, max_briefs=2, sync_hook=hook)
    caplog.set_level(logging.DEBUG)
    vol.ingest(sample_dir / "2026-09-01.json")
    vol.ingest(sample_dir / "2026-09-02.json")
    calls.clear()
    vol.ingest(sample_dir / "2026-09-03.json")  # prunes 09-01

    summary = [(m, p, q, u) for m, p, q, u, _ in calls]
    assert ("POST", "/rest/v1/briefs", "date", None) in summary
    assert ("POST", "/storage/v1/object/rendered-briefs/2026-09-03/index.html", None, "true") in summary
    assert ("POST", "/storage/v1/object/rendered-briefs/2026-09-02/index.html", None, "true") in summary
    assert ("POST", "/rest/v1/archive_index", "id", None) in summary
    assert ("DELETE", "/rest/v1/briefs", "in.(2026-09-01)", None) in summary
    assert ("DELETE", "/storage/v1/object/rendered-briefs", None, None) in summary
    briefs_body = json.loads(next(c for c in calls if c[1] == "/rest/v1/briefs" and c[0] == "POST")[4])
    assert [r["date"] for r in briefs_body] == ["2026-09-03"]
    idx_body = json.loads(next(c for c in calls if c[1] == "/rest/v1/archive_index")[4])
    assert idx_body == [{"id": 1, "data": vol.read_index()}]
    assert "service-secret" not in caplog.text


def test_sync_failure_does_not_break_ingest(monkeypatch, volume_root, sample_dir, caplog):
    monkeypatch.setenv("SYNC_TO_SUPABASE", "1")
    monkeypatch.setenv("SUPABASE_URL", "https://p.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "service-secret")
    hook = sync.hook_from_env(transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    vol = Volume(volume_root, sync_hook=hook)
    m = vol.ingest(sample_dir / "2026-09-01.json")
    assert m["retained"] == ["2026-09-01"]
    assert "post-ingest sync failed" in caplog.text
    assert "service-secret" not in caplog.text

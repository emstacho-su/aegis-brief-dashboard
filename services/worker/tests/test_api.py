from __future__ import annotations

import json
import re

import pytest
from fastapi.testclient import TestClient

from aegis_worker.api import create_app, inject_config
from aegis_worker.settings import Settings
from aegis_worker.volume import Volume

DASH = (
    "<title>x</title><style>a{}</style><div></div>\n"
    '<script src="https://cdnjs.cloudflare.com/x.js"></script>\n<script>const A=1;</script>'
)


def _settings(tmp_path, **env):
    web = tmp_path / "web"
    web.mkdir(exist_ok=True)
    (web / "dashboard.html").write_text(DASH, encoding="utf-8")
    base = {"VOLUME_ROOT": str(tmp_path / "vol"), "WEB_ROOT": str(web), "MAX_BRIEFS": "30"}
    base.update(env)
    return Settings.from_env(base)


@pytest.fixture
def seeded(tmp_path, sample_dir):
    s = _settings(tmp_path)
    vol = Volume(s.volume_root, s.max_briefs)
    vol.ingest_many(sorted(sample_dir.glob("*.json")))
    return s, vol


def test_root_injects_config_before_first_script(seeded):
    s, vol = seeded
    c = TestClient(create_app(s, vol))
    r = c.get("/")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    body = r.text
    first = body.index("<script")
    assert body[first:].startswith("<script>window.AEGIS_CONFIG=")
    cfg = json.loads(re.search(r"window\.AEGIS_CONFIG=(\{.*?\});</script>", body).group(1))
    assert cfg == {
        "apiBase": "",
        "supabaseUrl": "",
        "supabaseAnonKey": "",
        "requireAuth": False,
        "mode": "container",
    }
    assert body.index("AEGIS_CONFIG") < body.index("cdnjs")
    assert r.headers["cache-control"] == "no-cache"


def test_config_marker_is_replaced_when_present():
    page = '<script src="config.js"></script>\n<!-- AEGIS_CONFIG_INJECT -->\n<script>main()</script>'
    out = inject_config(page, {"mode": "container"})
    assert "AEGIS_CONFIG_INJECT" not in out
    assert out.index("config.js") < out.index("window.AEGIS_CONFIG") < out.index("main()")
    assert out.count("window.AEGIS_CONFIG") == 1


def test_config_script_cannot_break_out():
    out = inject_config("<script></script>", {"supabaseUrl": "</script><script>alert(1)</script>"})
    assert out.count("</script>") == 2
    assert "\\u003c/script\\u003e" in out


def test_health_archive_brief_and_html(seeded):
    s, vol = seeded
    c = TestClient(create_app(s, vol))
    h = c.get("/health").json()
    assert h == {"status": "ok", "retained": 22, "today": "2026-09-29", "volume_root": str(s.volume_root)}

    r = c.get("/api/archive")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    a = r.json()
    assert sorted(a["briefs"]) == a["manifest"]["retained"] == a["index"]["generated_from"]
    assert a["manifest"]["last_ingest"] == "2026-09-29"
    assert len(a["index"]["daily"]) == 22

    b = c.get("/api/briefs/2026-09-15")
    assert b.status_code == 200 and b.json()["date"] == "2026-09-15"
    assert c.get("/api/briefs/2026-09-17").status_code == 404
    assert c.get("/api/briefs/..%2F..%2Fetc").status_code in (400, 404)
    assert c.get("/api/briefs/2026-13-01").status_code == 400

    p = c.get("/briefs/2026-09-15.html")
    assert p.status_code == 200 and p.headers["content-type"].startswith("text/html")
    assert p.text == vol.read_html("2026-09-15")
    assert "default-src 'none'" in p.headers["content-security-policy"]
    assert c.get("/briefs/2026-09-17.html").status_code == 404
    assert c.get("/briefs/../manifest.json.html").status_code in (400, 404)

    cfg = c.get("/api/config")
    assert cfg.json()["mode"] == "container" and cfg.headers["cache-control"] == "no-store"


def test_ingest_disabled_by_default(seeded, samples):
    s, vol = seeded
    c = TestClient(create_app(s, vol))
    assert c.post("/api/ingest", json=samples["2026-09-01"]).status_code == 403


def test_ingest_enabled(tmp_path, samples):
    s = _settings(tmp_path, INGEST_ENABLED="1")
    vol = Volume(s.volume_root, s.max_briefs)
    c = TestClient(create_app(s, vol))
    r = c.post("/api/ingest", json=samples["2026-09-03"])
    assert r.status_code == 200
    assert r.json() == {"retained": ["2026-09-03"], "max_briefs": 30, "last_ingest": "2026-09-03"}
    assert c.get("/briefs/2026-09-03.html").status_code == 200
    bad = dict(samples["2026-09-04"])
    del bad["run"]
    r = c.post("/api/ingest", json=bad)
    assert r.status_code == 422 and r.json()["problems"]
    assert c.post("/api/ingest", content=b"{not json").status_code == 400
    assert vol.dates() == ["2026-09-03"]


def test_require_auth_gates_data_routes(seeded):
    s, vol = seeded
    s = Settings.from_env(
        {
            "VOLUME_ROOT": str(s.volume_root),
            "WEB_ROOT": str(s.web_root),
            "SUPABASE_URL": "https://p.supabase.co",
            "SUPABASE_ANON_KEY": "anon",
        }
    )
    assert s.require_auth is True
    c = TestClient(create_app(s, vol, token_verifier=lambda t: t == "good"))
    assert c.get("/health").status_code == 200
    assert c.get("/api/config").json()["requireAuth"] is True
    assert c.get("/").status_code == 200
    for path in ("/api/archive", "/api/briefs/2026-09-29", "/briefs/2026-09-29.html"):
        assert c.get(path).status_code == 401
        assert c.get(path, headers={"Authorization": "Bearer bad"}).status_code == 401
        assert c.get(path, headers={"Authorization": "Bearer good"}).status_code == 200
    c.cookies.set("aegis_token", "good")
    assert c.get("/briefs/2026-09-29.html").status_code == 200


def test_require_auth_without_supabase_fails_closed(seeded):
    s, vol = seeded
    s = Settings.from_env(
        {"VOLUME_ROOT": str(s.volume_root), "WEB_ROOT": str(s.web_root), "REQUIRE_AUTH": "1"}
    )
    c = TestClient(create_app(s, vol))
    assert c.get("/api/archive").status_code == 503


def test_empty_volume(tmp_path):
    s = _settings(tmp_path)
    c = TestClient(create_app(s, Volume(s.volume_root)))
    assert c.get("/health").json()["retained"] == 0
    a = c.get("/api/archive").json()
    assert a["briefs"] == {} and a["index"]["daily"] == [] and a["manifest"]["retained"] == []


def test_head_requests(seeded):
    s, vol = seeded
    c = TestClient(create_app(s, vol))
    assert c.head("/health").status_code == 200
    assert c.head("/briefs/2026-09-29.html").status_code == 200
    assert c.head("/").status_code == 200

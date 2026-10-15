from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

REPO = Path(__file__).resolve().parents[3]
SAMPLES = REPO / "data" / "briefs"
DASHBOARD = REPO / "apps" / "web" / "dashboard.html"


def _load_samples() -> dict[str, dict[str, Any]]:
    out = {}
    for p in sorted(SAMPLES.glob("*.json")):
        data = json.loads(p.read_text(encoding="utf-8"))
        out[data["date"]] = data
    return out


_SAMPLES = _load_samples()


@pytest.fixture
def samples() -> dict[str, dict[str, Any]]:
    """The sample briefs keyed by date (deep copy per test)."""
    return copy.deepcopy(_SAMPLES)


@pytest.fixture
def sample_dir() -> Path:
    return SAMPLES


@pytest.fixture
def volume_root(tmp_path: Path) -> Path:
    return tmp_path / "volume"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for k in (
        "SYNC_TO_SUPABASE",
        "SUPABASE_URL",
        "SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_KEY",
        "REQUIRE_AUTH",
        "INGEST_ENABLED",
        "VOLUME_ROOT",
        "MAX_BRIEFS",
        "WEB_ROOT",
    ):
        monkeypatch.delenv(k, raising=False)

"""Environment-driven settings (CONTRACT section 4)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .volume import DEFAULT_MAX_BRIEFS, DEFAULT_VOLUME_ROOT

_TRUE = ("1", "true", "yes", "on")
CONTAINER_WEB_ROOT = Path("/app/web")
REPO_WEB_ROOT = Path(__file__).resolve().parent.parent.parent.parent / "apps" / "web"


def _flag(env: dict[str, str], name: str, default: bool = False) -> bool:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in _TRUE


def default_web_root() -> Path:
    """``/app/web`` inside the container, else the repo's ``apps/web``."""
    return CONTAINER_WEB_ROOT if (CONTAINER_WEB_ROOT / "dashboard.html").is_file() else REPO_WEB_ROOT


@dataclass(frozen=True)
class Settings:
    """Runtime configuration. Secrets are kept out of ``repr``."""

    volume_root: Path
    max_briefs: int
    port: int
    ingest_enabled: bool
    supabase_url: str
    supabase_anon_key: str
    require_auth: bool
    web_root: Path
    max_ingest_bytes: int = 5 * 1024 * 1024

    def __repr__(self) -> str:
        return (
            f"Settings(volume_root={str(self.volume_root)!r}, max_briefs={self.max_briefs}, "
            f"port={self.port}, ingest_enabled={self.ingest_enabled}, "
            f"supabase_url={self.supabase_url!r}, require_auth={self.require_auth}, "
            f"web_root={str(self.web_root)!r})"
        )

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Settings:
        """Read settings from ``env`` (defaults to ``os.environ``)."""
        e = dict(os.environ if env is None else env)
        url = e.get("SUPABASE_URL", "").strip().rstrip("/")
        anon = e.get("SUPABASE_ANON_KEY", "").strip()
        return cls(
            volume_root=Path(e.get("VOLUME_ROOT") or DEFAULT_VOLUME_ROOT),
            max_briefs=int(e.get("MAX_BRIEFS") or DEFAULT_MAX_BRIEFS),
            port=int(e.get("PORT") or 8080),
            ingest_enabled=_flag(e, "INGEST_ENABLED"),
            supabase_url=url,
            supabase_anon_key=anon,
            require_auth=_flag(e, "REQUIRE_AUTH", default=bool(url and anon)),
            web_root=Path(e["WEB_ROOT"]) if e.get("WEB_ROOT") else default_web_root(),
        )

    def public_config(self) -> dict[str, Any]:
        """The ``window.AEGIS_CONFIG`` object (CONTRACT section 7). Only public values."""
        return {
            "apiBase": "",
            "supabaseUrl": self.supabase_url,
            "supabaseAnonKey": self.supabase_anon_key,
            "requireAuth": self.require_auth,
            "mode": "container",
        }

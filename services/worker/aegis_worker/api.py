"""FastAPI app (CONTRACT section 4).

Routes:

* ``GET /``                    dashboard.html from ``WEB_ROOT`` with ``window.AEGIS_CONFIG`` injected
* ``GET /health``              unauthenticated liveness and volume summary
* ``GET /api/archive``         ``{briefs, index, manifest}``
* ``GET /api/briefs/{date}``   one brief JSON
* ``GET /briefs/{date}.html``  the stored rendered page
* ``POST /api/ingest``         validate + store + rebuild; 403 unless ``INGEST_ENABLED=1``
* ``GET /api/config``          the public page config

When ``requireAuth`` is on, the data routes (``/api/archive``, ``/api/briefs/*``,
``/briefs/*.html``) require a Supabase access token, sent as ``Authorization: Bearer
<jwt>`` or as the ``aegis_token`` cookie; it is checked against Supabase
``/auth/v1/user`` (positive results cached for 60 s). ``/``, ``/health`` and
``/api/config`` stay public so the page can load and show its sign-in screen.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
from collections.abc import Callable
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from . import __version__
from . import sync as sync_mod
from .schema import BriefValidationError, is_valid_date
from .settings import Settings
from .volume import Volume

log = logging.getLogger(__name__)

NO_STORE = {"Cache-Control": "no-store"}
NO_CACHE = {"Cache-Control": "no-cache"}
BRIEF_CSP = (
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com; img-src data:; base-uri 'none'; form-action 'none'; "
    "frame-ancestors 'self'"
)
_SCRIPT_RE = re.compile(r"<script\b", re.IGNORECASE)
TOKEN_COOKIE = "aegis_token"
CONFIG_MARKER = "<!-- AEGIS_CONFIG_INJECT -->"

TokenVerifier = Callable[[str], bool]


def config_script(cfg: dict[str, Any]) -> str:
    """Return a ``<script>`` tag assigning ``window.AEGIS_CONFIG``, safe inside HTML."""
    payload = json.dumps(cfg, sort_keys=True, separators=(",", ":"))
    for ch, rep in (("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026"), (" ", "\\u2028"), (" ", "\\u2029")):
        payload = payload.replace(ch, rep)
    return f"<script>window.AEGIS_CONFIG={payload};</script>\n"


def inject_config(html: str, cfg: dict[str, Any]) -> str:
    """Insert the ``window.AEGIS_CONFIG`` script into the dashboard page.

    If the page carries the ``<!-- AEGIS_CONFIG_INJECT -->`` marker (placed after its
    optional ``config.js`` tag) the marker is replaced, so the injected config wins.
    Otherwise the script goes before the first ``<script`` tag (CONTRACT section 4), or
    before ``</body>``, or at the end.
    """
    tag = config_script(cfg)
    if CONFIG_MARKER in html:
        return html.replace(CONFIG_MARKER, tag.rstrip("\n"), 1)
    m = _SCRIPT_RE.search(html)
    if m:
        return html[: m.start()] + tag + html[m.start() :]
    idx = html.lower().rfind("</body>")
    return html[:idx] + tag + html[idx:] if idx >= 0 else html + tag


class SupabaseTokenVerifier:
    """Check a Supabase access token by calling ``GET /auth/v1/user``."""

    def __init__(
        self, url: str, anon_key: str, ttl: float = 60.0, transport: httpx.BaseTransport | None = None
    ) -> None:
        self._url = url.rstrip("/")
        self._anon = anon_key
        self._ttl = ttl
        self._cache: dict[str, float] = {}
        self._lock = threading.Lock()
        self._transport = transport

    def __call__(self, token: str) -> bool:
        key = hashlib.sha256(token.encode()).hexdigest()
        now = time.monotonic()
        with self._lock:
            exp = self._cache.get(key)
            if exp and exp > now:
                return True
        try:
            with httpx.Client(timeout=5.0, transport=self._transport) as c:
                r = c.get(
                    f"{self._url}/auth/v1/user",
                    headers={"apikey": self._anon, "Authorization": f"Bearer {token}"},
                )
        except httpx.HTTPError:
            log.warning("token verification request failed")
            return False
        ok = r.status_code == 200
        if ok:
            with self._lock:
                if len(self._cache) > 1024:
                    self._cache.clear()
                self._cache[key] = now + self._ttl
        return ok


def _check_date(date: str) -> str:
    if not is_valid_date(date):
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD", headers=NO_STORE)
    return date


def create_app(
    settings: Settings | None = None,
    volume: Volume | None = None,
    token_verifier: TokenVerifier | None = None,
) -> FastAPI:
    """Create the FastAPI app. Arguments default to values read from the environment."""
    s = settings or Settings.from_env()
    vol = volume or Volume(s.volume_root, s.max_briefs, sync_hook=sync_mod.hook_from_env())
    verifier = token_verifier
    if verifier is None and s.require_auth and s.supabase_url and s.supabase_anon_key:
        verifier = SupabaseTokenVerifier(s.supabase_url, s.supabase_anon_key)

    app = FastAPI(
        title="AEGIS brief worker", version=__version__, docs_url=None, redoc_url=None, openapi_url=None
    )
    app.state.settings = s
    app.state.volume = vol

    @app.middleware("http")
    async def security_headers(request: Request, call_next: Callable[..., Any]) -> Response:
        resp: Response = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        return resp

    def require_user(request: Request) -> None:
        if not s.require_auth:
            return
        if verifier is None:
            raise HTTPException(
                503, "authentication required but Supabase is not configured", headers=NO_STORE
            )
        auth = request.headers.get("authorization", "")
        token = (
            auth[7:].strip() if auth.lower().startswith("bearer ") else request.cookies.get(TOKEN_COOKIE, "")
        )
        if not token or not verifier(token):
            raise HTTPException(
                401, "authentication required", headers={**NO_STORE, "WWW-Authenticate": "Bearer"}
            )

    @app.api_route("/", methods=["GET", "HEAD"], response_class=HTMLResponse)
    def index_page() -> HTMLResponse:
        path = s.web_root / "dashboard.html"
        try:
            html = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            raise HTTPException(404, "dashboard.html not found in WEB_ROOT", headers=NO_STORE) from None
        return HTMLResponse(inject_config(html, s.public_config()), headers=NO_CACHE)

    @app.api_route("/health", methods=["GET", "HEAD"])
    def health() -> JSONResponse:
        dates = vol.dates()
        return JSONResponse(
            {
                "status": "ok",
                "retained": len(dates),
                "today": dates[-1] if dates else None,
                "volume_root": str(vol.root),
            },
            headers=NO_STORE,
        )

    @app.get("/api/config")
    def api_config() -> JSONResponse:
        return JSONResponse(s.public_config(), headers=NO_STORE)

    @app.get("/api/archive")
    def api_archive(request: Request) -> Response:
        require_user(request)
        with vol.locked():
            body = {
                "briefs": vol.read_all_briefs(),
                "index": vol.read_index(),
                "manifest": vol.read_manifest(),
            }
        return Response(
            json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")),
            media_type="application/json",
            headers=NO_STORE,
        )

    @app.get("/api/briefs/{date}")
    def api_brief(date: str, request: Request) -> JSONResponse:
        require_user(request)
        data = vol.read_brief(_check_date(date))
        if data is None:
            raise HTTPException(404, "no brief for that date", headers=NO_STORE)
        return JSONResponse(data, headers=NO_STORE)

    @app.api_route("/briefs/{date}.html", methods=["GET", "HEAD"], response_class=HTMLResponse)
    def brief_html(date: str, request: Request) -> HTMLResponse:
        require_user(request)
        html = vol.read_html(_check_date(date))
        if html is None:
            raise HTTPException(404, "no rendered brief for that date", headers=NO_STORE)
        return HTMLResponse(
            html, headers={"Cache-Control": "private, no-cache", "Content-Security-Policy": BRIEF_CSP}
        )

    @app.post("/api/ingest")
    async def api_ingest(request: Request) -> JSONResponse:
        if not s.ingest_enabled:
            raise HTTPException(403, "ingest is disabled (set INGEST_ENABLED=1)", headers=NO_STORE)
        raw = await request.body()
        if len(raw) > s.max_ingest_bytes:
            raise HTTPException(413, "brief too large", headers=NO_STORE)
        try:
            data = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(400, f"invalid JSON: {exc}", headers=NO_STORE) from None
        if not isinstance(data, dict):
            raise HTTPException(422, "brief must be a JSON object", headers=NO_STORE)
        try:
            manifest = await run_in_threadpool(vol.ingest, data)
        except BriefValidationError as exc:
            return JSONResponse(
                {"detail": "brief failed schema validation", "problems": exc.problems, "total": exc.total},
                status_code=422,
                headers=NO_STORE,
            )
        return JSONResponse(manifest, headers=NO_STORE)

    return app

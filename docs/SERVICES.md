# Service entry: brief-dashboard

AEGIS convention: one service per container, one entry per service, versioned image tags.

| Field | Value |
|---|---|
| Name | `brief-dashboard` |
| Purpose | Validate, render, index and serve the AEGIS daily brief archive (30 days) as a dashboard. |
| Owner | AEGIS daily brief overhaul (phase 4: dashboard container). |
| Source | This repo. Worker in `services/worker/`, page in `apps/web/`. |
| Dockerfile | `services/worker/Dockerfile`, built with the repo root as context. |
| Image | `aegis-brief-dashboard:<git-sha-12>` |
| Tag convention | The first 12 characters of the commit SHA (`git rev-parse --short=12 HEAD`). One tag per commit. Never `:latest`. A release may add a second tag `v<semver>` pointing at the same digest. Deploy by SHA tag only. |
| Base runtime | Python (3.11 or newer; see the Dockerfile), FastAPI, uvicorn. Single process. |
| Ports | `8080/tcp` inside the container (`PORT`). Host port via `HOST_PORT`, bind address via `BIND_ADDR`. |
| Volumes | `aegis_volume` at `/var/lib/aegis/volume` (`VOLUME_ROOT`). Holds `briefs/<date>/brief.json`, `briefs/<date>/index.html`, `archive-index.json`, `manifest.json`. Derived data: rebuildable from brief JSON files. |
| Seed | On first start with an empty volume, ingests `SEED_DIR` (default `/app/data/briefs`, the fictional samples). Empty `SEED_DIR` skips it. |
| Health | `GET /health`, unauthenticated: `{status, retained, today, volume_root}`. Compose checks it every 30 s. |
| Restart policy | `unless-stopped` |
| Secrets | `SUPABASE_SERVICE_KEY` (only when `SYNC_TO_SUPABASE=1`). Passed by env from `.env` on the host. Never baked into the image, never sent to the browser. |
| Public config | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `REQUIRE_AUTH`. Injected into the page as `window.AEGIS_CONFIG`. |
| Other env | `MAX_BRIEFS` (30), `INGEST_ENABLED` (0 in the worker, 1 in compose), `SEED_DIR`, `SYNC_TO_SUPABASE` (0), `LOG_LEVEL` (INFO), `WEB_ROOT` (`/app/web`). |
| Upstream | The daily brief loop, which produces one brief JSON per day (`docs/CONTRACT.md` section 1). Delivered by `POST /api/ingest` or `aegis-worker ingest`. |
| Downstream | Readers (browser). Optional mirror to Supabase (`briefs`, `archive_index`, `rendered-briefs` bucket). |
| Dependencies | None required at runtime. Supabase is optional: needed for sign-in (`REQUIRE_AUTH=1`), synced feedback and settings, and the static Vercel path. Fonts load from Google Fonts and `html2canvas` from cdnjs in the browser. |
| Auth | With `REQUIRE_AUTH=1`, data routes require a Supabase session token (Bearer header or `aegis_token` cookie), verified against Supabase. `/`, `/health`, `/api/config` stay public. `POST /api/ingest` has no auth: keep `INGEST_ENABLED=0` on any host reachable by untrusted clients. |
| Data handling | Real briefs carry TLP markings. The volume, backups and any Supabase mirror inherit the most restrictive marking present. |
| Runbook | `docs/RUNBOOK.md` |
| Deploy | `docs/DEPLOY.md` |

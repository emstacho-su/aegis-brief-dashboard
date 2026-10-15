# AEGIS brief dashboard

The AEGIS daily brief produces one JSON file per day: ranked items, an exposure register, outstanding actions and context. This repo turns those files into a dashboard. A Python worker validates each brief against a JSON Schema, renders a static page for it, rebuilds a 30-day archive index (lifecycles, events, daily stats), and prunes anything older. A single-page web app reads that archive and shows Home, Area, Brief, Trends and Archive views.

It runs two ways. The container is the main deployment: one image, one volume, the API and the page on port 8080, on any device with Docker. The second path is static hosting: the page on Vercel reads the same data from Supabase, behind a magic-link sign-in, with no container in the request path. `docs/CONTRACT.md` is the binding spec for data shapes, the volume, the API and the Supabase schema.

The 22 briefs in `data/briefs/` are fictional samples and safe to publish. Real briefs carry TLP markings. Do not commit them, and check their handling rules before syncing them to a cloud Supabase project.

## Architecture

```
                      container path (local / any device)
 briefs JSON ──> worker ─────────────────────────────> volume ──> API ──> dashboard
 (one per day)   validate (schema, fail closed)         briefs/<date>/brief.json      GET /api/archive
                 render   (deterministic HTML)          briefs/<date>/index.html      GET /briefs/<date>.html
                 index    (archive-index.json)          archive-index.json            GET / (config injected)
                 prune    (keep MAX_BRIEFS dates)       manifest.json

                      static path (Vercel + Supabase)
 worker (SYNC_TO_SUPABASE=1) ──> Supabase: briefs, archive_index, rendered-briefs bucket
                                     ^
 Vercel: apps/web + config.js ───────┘  page reads tables with the reader's session (RLS)
                                         feedback + settings -> Supabase tables and bucket
```

## Quick start

### 1. Run the container on any device with Docker

```bash
cp .env.example .env                 # defaults work as is; Supabase is optional
IMAGE_TAG=$(git rev-parse --short=12 HEAD) docker compose up -d --build
docker compose ps                    # wait for (healthy)
# then browse to http://localhost:8080, or http://<device-ip>:8080 from another machine
```

On first start the empty volume is seeded with the sample briefs. Add a brief with `curl -X POST -H 'content-type: application/json' --data-binary @brief.json http://localhost:8080/api/ingest`, or simulate a day passing with `scripts/replay.sh`. See `docs/RUNBOOK.md`.

### 2. Run locally without Docker

```bash
scripts/dev.sh            # creates .venv, installs the worker, ingests data/briefs into ./volume, serves :8080
scripts/dev.sh --fresh    # same, starting from an empty ./volume
```

Needs Python 3.11 or newer. Run the worker tests with `cd services/worker && ../../.venv/bin/python -m pytest -q`.

### 3. Deploy to Vercel + Supabase

1. Create a Supabase project. Run `supabase/migrations/0001_init.sql` in the SQL editor.
2. Turn on email magic links and add your Vercel URL to the redirect list.
3. Load data: `SYNC_TO_SUPABASE=1 aegis-worker ingest-dir data/briefs` (canonical) or `python3 supabase/seed.py` (fallback, brief rows only).
4. Import this repo in Vercel. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY`. `vercel.json` does the rest.

Full steps, including auth and feedback flow per mode: `docs/DEPLOY.md`.

## Repo layout

| Path | What it is | Owner |
|---|---|---|
| `apps/web/dashboard.html` | The single-file dashboard (HTML, CSS, JS). Reads `window.AEGIS_CONFIG`. | web |
| `apps/web/config.js` | Generated for static hosting by `scripts/build_static.py`. Git-ignored. | platform |
| `services/worker/` | `aegis-worker` Python package: CLI, FastAPI server, renderer, index, sync. Dockerfile. | worker |
| `packages/` | Shared contract files: `brief.schema.json`, `areas.json`. | contract |
| `data/briefs/` | 22 fictional sample briefs. | contract |
| `supabase/` | Migration, fallback seed script, setup notes. | platform |
| `scripts/` | `dev.sh`, `replay.sh`, `new_brief.py`, `build_static.py`, CI helpers. | platform |
| `docker-compose.yml` | `dashboard` service and the `replay` profile. | platform |
| `vercel.json` | Static hosting of `apps/web`. | platform |
| `.github/workflows/ci.yml` | Tests, schema check, image build and smoke test, web syntax check. | platform |
| `docs/` | Contract, runbook, service entry, deploy guide. | platform |

## Docs

- `docs/CONTRACT.md`: data shapes, volume layout, API, determinism, Supabase schema. Change it first.
- `docs/DEPLOY.md`: Supabase, Vercel and Docker deployment, step by step.
- `docs/RUNBOOK.md`: day-to-day operations and common failures.
- `docs/SERVICES.md`: the AEGIS service entry for `brief-dashboard`.
- `supabase/README.md`: what the migration creates and how to apply it.

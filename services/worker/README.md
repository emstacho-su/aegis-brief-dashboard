# aegis-worker

The Python service behind the AEGIS daily brief dashboard. It validates each brief against
`packages/brief.schema.json`, stores it in a rotating volume, rebuilds the archive index,
renders a static HTML page per brief, can mirror everything to Supabase, and serves the
dashboard page and a small JSON API. `docs/CONTRACT.md` is the binding spec. This README
covers how to run the service.

## Layout

```
aegis_worker/
  schema.py      JSON Schema (Draft 2020-12) validation + Pydantic models (Brief, Item, ExposureRow, ...)
  index.py       build_index(): lifecycles, events, daily aggregates (CONTRACT section 2)
  render.py      render_brief(): the static L2 brief page (templates/brief.html.j2 + brief.css)
  volume.py      Volume: ingest, prune, re-index, re-render, manifest (CONTRACT section 3)
  sync.py        optional Supabase mirror (SYNC_TO_SUPABASE=1)
  api.py         FastAPI app (CONTRACT section 4)
  cli.py         the aegis-worker command
  settings.py    environment variables
  shared.py      finds packages/brief.schema.json and packages/areas.json
  jsonio.py      canonical JSON and atomic writes
tests/           pytest suite
Dockerfile       build from the repo root
```

## Run locally

Python 3.11 or newer.

```sh
cd services/worker
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'

export VOLUME_ROOT=$PWD/.volume          # default is /var/lib/aegis/volume
aegis-worker ingest-dir ../../data/briefs
aegis-worker serve                        # http://localhost:8080
```

Tests (node is optional; without it the JavaScript index comparison is skipped):

```sh
cd services/worker && python -m pytest -q
ruff check . && ruff format --check .
```

### Shared contract files

The worker never edits or copies `packages/*.json` in the repo. `shared.py` looks for them
in this order:

1. `$AEGIS_PACKAGES_DIR`
2. the repo's `packages/` (from a checkout or an editable install)
3. `aegis_worker/_shared/` inside the installed package

The Dockerfile copies both files into `aegis_worker/_shared/` before `pip install`, so the
image carries them as package data. To build a wheel outside Docker, run
`python -m aegis_worker.shared --sync` first. `_shared/` is git-ignored.

## CLI

| Command | What it does |
|---|---|
| `aegis-worker ingest <file.json>` | Validate, store, prune, re-index, re-render. Prints the manifest. |
| `aegis-worker ingest-dir <dir> [--if-empty]` | Ingest every `*.json` in `dir` in brief-date order, with one rebuild at the end. `--if-empty` does nothing if the volume already has briefs (the container uses this to seed). |
| `aegis-worker rebuild` | Re-validate the stored briefs, then re-prune, re-index and re-render. Use it after an upgrade that changes the renderer. |
| `aegis-worker replay <dir> --step` | Ingest the earliest brief in `dir` whose date is not in the volume, and print what it did. This simulates one day's arrival. Without `--step` it ingests all of them, one at a time. Once the volume is full, dates older than the oldest retained date are skipped, because they would be pruned straight away. |
| `aegis-worker serve [--host 0.0.0.0] [--port N]` | Run uvicorn on `$PORT` (default 8080). |

Exit codes: 0 for success, 1 for a validation or input error (the first five schema
problems go to stderr), 2 for a usage error. A validation failure writes nothing.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `VOLUME_ROOT` | `/var/lib/aegis/volume` | Volume directory |
| `MAX_BRIEFS` | `30` | Retention, counted in brief dates |
| `PORT` | `8080` | Port for `serve` |
| `INGEST_ENABLED` | `0` | `1` turns on `POST /api/ingest`. The endpoint has no auth of its own. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | empty | Public values, injected into the page and used to verify session tokens |
| `REQUIRE_AUTH` | `1` when URL and anon key are set, else `0` | Data routes require a Supabase session |
| `SYNC_TO_SUPABASE` | `0` | `1` mirrors every ingest to Supabase. Needs `SUPABASE_SERVICE_KEY`. |
| `SUPABASE_SERVICE_KEY` | empty | Used only for sync. It is never logged or exposed. |
| `WEB_ROOT` | `/app/web` in the image, otherwise `../../apps/web` | Folder that holds `dashboard.html` |
| `SEED_DIR` | `/app/data/briefs` in the image | The entrypoint seeds an empty volume from this folder. Set it to empty to turn seeding off. |
| `AEGIS_PACKAGES_DIR` | unset | Overrides where the shared JSON files are read from |
| `LOG_LEVEL` | `INFO` | CLI and server log level |

## HTTP API

| Route | Notes |
|---|---|
| `GET /` | `dashboard.html` with `<script>window.AEGIS_CONFIG={...}</script>`. The script replaces the `<!-- AEGIS_CONFIG_INJECT -->` marker if the page has one. Otherwise it goes before the first `<script>`. The JSON is escaped so it cannot close the tag. Sent with `no-cache`. |
| `GET /config.js` | Empty `application/javascript` body, `no-cache`. The page's config is injected inline at `/`; this file exists so the page's `config.js` tag does not 404. Never authenticated. |
| `GET /health` | `{status, retained, today, volume_root}`. `retained` is a count. Never authenticated. |
| `GET /api/config` | `{apiBase:'', supabaseUrl, supabaseAnonKey, requireAuth, mode:'container'}` |
| `GET /api/archive` | `{briefs: {date: brief}, index, manifest}` |
| `GET /api/briefs/{date}` | One stored brief. A malformed date returns 400 and an unknown date returns 404. |
| `GET /briefs/{date}.html` | The stored render, sent with a strict CSP (no scripts) |
| `POST /api/ingest` | Body is the brief JSON. Returns the manifest. Returns 403 unless `INGEST_ENABLED=1`, and 422 with `problems` on a schema failure. |

The `{date}` parameter must be a real `YYYY-MM-DD` date before it touches the filesystem.
API responses send `Cache-Control: no-store`.

With `REQUIRE_AUTH=1`, the three data routes require a Supabase access token. Send it as
`Authorization: Bearer <jwt>`, or as the `aegis_token` cookie for links opened in a new
tab. The worker checks the token against `${SUPABASE_URL}/auth/v1/user` and caches a
positive result for 60 seconds. If `REQUIRE_AUTH=1` is set without the Supabase values,
those routes fail closed with 503. `/`, `/config.js`, `/health` and `/api/config` stay public.

## Supabase sync

With `SYNC_TO_SUPABASE=1`, `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` set, each ingest does
four things through the REST and Storage APIs:

- upserts `briefs(date, data)` for the dates it ingested (a `rebuild` upserts every retained date)
- uploads each rendered page whose bytes changed to `rendered-briefs/<date>/index.html` (upsert)
- upserts `archive_index(id=1, data)`
- deletes the `briefs` rows and stored pages for pruned dates, so the mirror keeps the same window

Without that configuration the sync step does nothing. A sync failure is logged and does
not fail the ingest, because the volume is the source of truth. Run `aegis-worker rebuild`
to push everything again.

## Container

```sh
docker build -f services/worker/Dockerfile -t aegis-brief-dashboard:local .   # from the repo root
docker run -p 8080:8080 -v aegis_volume:/var/lib/aegis/volume aegis-brief-dashboard:local
```

- The base image is `python:3.12-slim`, and the container runs as the non-root user `aegis` (uid 10001).
- The image contains the installed package, `packages/*.json` (as package data), `apps/web/dashboard.html` at `/app/web/`, and `data/briefs` at `/app/data/briefs`.
- `VOLUME /var/lib/aegis/volume`, `EXPOSE 8080`, and a `HEALTHCHECK` that calls `/health`.
- The entrypoint (`docker-entrypoint.sh`) runs `aegis-worker ingest-dir --if-empty "$SEED_DIR"` and then execs the command. The default command is `aegis-worker serve`.
- The default `SEED_DIR` seeds the 22 fictional sample briefs into an empty volume. For a volume that will hold real briefs, set `SEED_DIR=` so samples do not mix with real data until they age out.
- `services/worker/Dockerfile.dockerignore` keeps the build context small (BuildKit reads it).

## Determinism guarantees

- **Volume state depends only on the retained briefs.** After every ingest the worker prunes, rebuilds the index and re-renders every retained page, and it rewrites only the files whose bytes changed. `ingest-dir`, one-at-a-time `ingest`, `replay` and `rebuild` therefore produce byte-identical volumes, and the tests check this. Re-rendering every page matters because each page shows archive-wide facts: the Today marker, the neighbouring dates and the archive size.
- **JSON is canonical.** Keys are sorted, floats are rounded to 4 places, the encoding is UTF-8, the indent is two spaces and every file ends with a newline. Input briefs are canonicalized before they are stored or rendered, so key order in the input never matters.
- **Rendering never reads the clock.** The only timestamps on a page come from the brief. Every iteration is explicitly ordered: items by score (stable, as in the web app), exposure rows by state then age, note sections in the web app's label order and then by key, and `score_parts` by key.
- **`manifest.last_ingest` is a brief date, not `now()`.**
- **The index matches the web app's `buildIndex`.** The test suite extracts `buildIndex` from `apps/web/dashboard.html`, runs it under node on the sample data, and asserts the two outputs are equal after normalization (sorted keys, numbers compared at 4 decimal places).

## Rendering and safety

- Jinja2 autoescape is on. Every string from a brief is escaped.
- Indicators are defanged the way the web app's `defang` does it: a leading `http` becomes `hxxp` (case-insensitive) and every `.` becomes `[.]`. They are never rendered as links.
- Source URLs become links only when they are absolute `http(s)` URLs, opened with `rel="noopener noreferrer"`. Anything else, such as `javascript:`, is shown as plain text.
- The page uses no JavaScript. Tier 1 items are expanded. Tier 2 and 3 items, context bullets and brief sections open with `<details>`.
- The CSS token blocks are copied verbatim from `dashboard.html`. A test fails if they drift apart.

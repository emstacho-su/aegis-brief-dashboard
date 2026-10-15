# Contract: data shapes, volume layout, API, determinism

This file is the single source of truth for every component in the repo. The worker (Python), the web app (single-file HTML/JS) and the Supabase schema all conform to it. Change it here first.

## 1. Brief JSON (one file per day, `data/briefs/YYYY-MM-DD.json`)

Top level:

| Field | Type | Notes |
|---|---|---|
| `date` | `YYYY-MM-DD` string | primary key |
| `baseline_date` | string or null | the previous brief's date, as the producer saw it; the index recomputes it |
| `items` | `Item[]` | see below |
| `outstanding` | `Action[]` | may be empty; real briefs use `exposure` instead |
| `exposure` | `ExposureRow[]` | the standing exposure register |
| `context` | `{geopolitical: Bullet[] or null, ai_watch: Bullet[] or null, watchlist: WatchBullet[] or null}` | |
| `notes` | `{[section: string]: string}` | brief sections kept as written |
| `banners` | `{cls: 'err' or 'warn', text: string}[]` | |
| `threat_level` | string | `CRITICAL`, `HIGH`, `ELEVATED`, or empty |
| `fm` | object | frontmatter counts; informational only |
| `run` | `{at, model, schema, valid: bool, feeds_fresh: int or null, feeds_total: int or null, stale: string[], chunks: int, prior_chunks: int}` | |

Item:

| Field | Type | Notes |
|---|---|---|
| `item_id` | string | stable across days; everything keys on it |
| `kind` | `cve`, `campaign`, `advisory`, `actor`, `research` | |
| `areas` | string[] | keys of the area taxonomy; non-empty (`other` when unmapped) |
| `tier` | 1, 2, 3 | |
| `priority` | `critical`, `high`, `medium`, `low` | |
| `status` | `new`, `continued` | |
| `continued_days` | int | 0 when new |
| `score` | int 0 to 100 | |
| `score_parts` | `{[letter]: number}` | may be empty |
| `tlp` | `clear`, `green`, `amber`, `amber_strict`, `red` | |
| `identifiers` | string[] | CVE or advisory ids |
| `title`, `description`, `su_impact`, `delta`, `body` | string | `body` may be empty |
| `source` | `{name, url, retrieved}` | |
| `recommended_actions` | string[] | |
| `escalation` | `{required: bool, to: string, note: string}` | |
| `first_seen` | `YYYY-MM-DD` | |
| `cve_published` | `YYYY-MM-DD` or null | |
| `attack` | string[] | ATT&CK ids |
| `confidence` | `high`, `moderate`, `low`, or empty | |
| `indicators` | `[type, value][]` | rendered defanged, never as links |

ExposureRow: `{item: string, state: 'vulnerable' | 'confirmed' | 'conflicted' | 'unverified' | 'mitigated', state_text: string, basis: string, days: int or null, standing: bool, areas: string[]}`

Action: `{action_id, text, origin: item_id, raised: date, days: int, areas: string[]}`

Bullet: `{t: string, d: string, s: string}`. WatchBullet adds `since: string, trigger: string`.

Area taxonomy keys: `identity, endpoints, perimeter, email, webapps, cloud, supply, research, ai, other`. Display names live in the web app and the worker's renderer (`packages/areas.json` is the shared file).

A JSON Schema for all of the above is `packages/brief.schema.json`. The worker validates every brief against it and fails closed.

## 2. Archive index (`archive-index.json`, derived, never model-authored)

Built from the set of retained briefs, in date order. The web app contains an equivalent JavaScript implementation (`buildIndex` in `apps/web/dashboard.html`) used as a fallback; the Python implementation is canonical and the test suite asserts the two produce identical output on the sample data.

```
{
  "generated_from": ["YYYY-MM-DD", ...],          // retained brief dates, ascending
  "today": "YYYY-MM-DD",                          // last date
  "life": { item_id: Lifecycle },
  "events": Event[],
  "daily": Daily[]
}
```

Lifecycle:

| Field | Definition |
|---|---|
| `id`, `title`, `kind`, `areas`, `identifiers` | from the latest observation (title), union across days (areas, identifiers) |
| `sources` | sorted unique source names across days |
| `first_seen` | the item's own `first_seen` on its first observation |
| `last_seen` | last retained date present |
| `days` | retained dates present, ascending |
| `tiers`, `scores`, `pris` | parallel to `days` |
| `escDays` | dates where `escalation.required` |
| `maxTier` | min tier number seen; `maxScore`; `t1days` count of days at tier 1 |
| `resolved` | `last_seen != today` |

Events, computed between consecutive retained briefs (prev, cur), in this order per brief: for each item in cur (brief order): `new` (absent in prev and no earlier presence) or `returned` (absent in prev, present earlier); else `promoted` (tier lower-numbered), `demoted` (tier higher-numbered), else `score_jump` (abs change >= 15); plus `escalated` (required now, not before). Then for each item in prev absent in cur: `dropped`. Then `action_raised` / `action_closed` by `action_id`. Event shape: `{date, type, id, areas, text, w}` with `w` = 3 for tier-1 new / promoted / escalated, 2 for score_jump / action events, 1 otherwise. Text strings are exactly those in the web app's `buildIndex`.

Daily: `{date, items, t1, t2, t3, new, dropped, esc, actions, avgAge, avgActionAge, valid, byArea: {area: count}}` where `avgAge` is the mean of `continued_days + 1` over items present and `dropped` is the count of `dropped` events dated that day.

## 3. The volume

```
VOLUME_ROOT/
  briefs/YYYY-MM-DD/brief.json        validated copy of the input
  briefs/YYYY-MM-DD/index.html        deterministic render of the brief (L2 page)
  archive-index.json                  rebuilt after every ingest and prune
  manifest.json                       {retained: [dates], max_briefs: 30, last_ingest: date}
```

Retention: keep the 30 most recent brief dates; prune older directories after every ingest. Retention is by brief date, not render date. Re-ingesting an existing date replaces it in place.

## 4. Worker and API (Python, FastAPI, one container)

| Route | Method | Behavior |
|---|---|---|
| `/` | GET | the dashboard page with `window.AEGIS_CONFIG` injected |
| `/health` | GET | unauthenticated `{status, retained, today, volume_root}` |
| `/api/archive` | GET | `{briefs: {date: brief}, index: ArchiveIndex, manifest}` |
| `/api/briefs/{date}` | GET | one brief JSON |
| `/briefs/{date}.html` | GET | the stored rendered HTML for that date |
| `/api/ingest` | POST | body = brief JSON; validate, render, store, rebuild index, prune; returns manifest. Local use; disabled unless `INGEST_ENABLED=1` |
| `/api/config` | GET | the public config the page uses (Supabase URL and anon key, requireAuth) |

CLI (same package): `aegis-worker ingest <file.json>`, `aegis-worker ingest-dir <dir>`, `aegis-worker rebuild`, `aegis-worker replay <dir> --step` (ingest the next unseen file, for simulating daily arrival), `aegis-worker serve`.

Environment: `VOLUME_ROOT` (default `/var/lib/aegis/volume`), `MAX_BRIEFS` (30), `PORT` (8080), `INGEST_ENABLED`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` (worker only, for sync), `REQUIRE_AUTH` (default 1 when Supabase is configured, else 0), `SYNC_TO_SUPABASE` (0/1).

When `SYNC_TO_SUPABASE=1`, after every ingest the worker upserts the brief row, uploads the rendered HTML to the `rendered-briefs` bucket and upserts `archive_index`.

## 5. Determinism rules

- Same input files, same output bytes. No wall-clock timestamps in rendered HTML or the index; `manifest.last_ingest` is the brief date, not now().
- Rendering escapes every string; indicators are defanged (`http` to `hxxp`, `.` to `[.]`) and never rendered as links; external source URLs are the only live links.
- Dictionary ordering in JSON output is sorted keys; floats are rounded to 4 places.
- Snapshot tests cover: schema validation (valid sample, rejected malformed), byte-identical render across two runs, index equality with the JavaScript fallback, retention pruning, replay ordering.

## 6. Supabase

Tables: `briefs(date text pk, data jsonb, updated_at)`, `archive_index(id int pk default 1, data jsonb, updated_at)`, `feedback(id uuid pk, user_id uuid, created_at, page text, bug text, change text, screenshot_path text)`, `user_settings(user_id uuid pk, my_areas jsonb, stars jsonb, viewed jsonb, theme text, updated_at)`.

Buckets: `rendered-briefs` (private, read for authenticated), `feedback-screenshots` (private, insert for authenticated, read for own).

RLS: authenticated users can select `briefs` and `archive_index`; a user can insert their own `feedback` and select their own; a user can select, insert and update their own `user_settings`. The service key (worker) bypasses RLS for upserts.

Auth: Supabase magic link (email OTP). The web app gates every view behind a session when `requireAuth` is true, and uses the session's user id for settings and feedback.

## 7. Web app config

The page reads `window.AEGIS_CONFIG = {apiBase: '', supabaseUrl: '', supabaseAnonKey: '', requireAuth: false, mode: 'container' | 'static'}`.

- `container` mode: data from `apiBase + '/api/archive'`; feedback and settings go to Supabase when configured, else browser storage.
- `static` mode (Vercel): data from Supabase tables directly (`briefs`, `archive_index`) with the user's session; no container API.
- With no config at all the page falls back to its embedded synthetic data, which keeps it reviewable from disk.

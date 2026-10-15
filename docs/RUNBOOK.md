# Runbook: brief-dashboard

Operations for the container deployment. Commands run from the repo root on the Docker host. For the non-Docker setup, drop the `docker compose exec dashboard` prefix and run `aegis-worker` inside `.venv` with `VOLUME_ROOT=./volume`.

Facts used throughout:

- Service: `dashboard`. Volume: `aegis_volume`, mounted at `/var/lib/aegis/volume`.
- Image: `aegis-brief-dashboard:<git sha>`. Port 8080.
- Retention: the 30 most recent brief dates (`MAX_BRIEFS`). Pruning runs after every ingest.
- Every ingest validates against `packages/brief.schema.json` and fails closed. A rejected brief changes nothing.

## Check health

```bash
curl -s http://localhost:8080/health
docker compose ps
```

`/health` is unauthenticated and returns:

| Field | Meaning |
|---|---|
| `status` | `ok` when the server is up and can read the volume. |
| `retained` | Number of brief dates in the volume. 0 means the seed did not run or the volume is new and `SEED_DIR` is empty. |
| `today` | The newest retained brief date, or `null`. This is the brief date, not the clock. |
| `volume_root` | Path the server reads. Should be `/var/lib/aegis/volume` in Docker. |

The compose healthcheck calls `/health` every 30 seconds. Three failures mark the container unhealthy. `restart: unless-stopped` restarts it if the process exits.

## Ingest a new brief

Pick one.

```bash
# Over HTTP. Needs INGEST_ENABLED=1.
curl -fsS -X POST -H 'content-type: application/json' \
     --data-binary @2026-10-01.json http://localhost:8080/api/ingest

# Through the CLI in the running container.
docker compose cp 2026-10-01.json dashboard:/tmp/brief.json
docker compose exec dashboard aegis-worker ingest /tmp/brief.json
```

Both return the manifest. A 422 response or a non-zero exit lists the schema problems. Re-ingesting a date replaces it in place.

To make a test brief: `python3 scripts/new_brief.py` writes the next day to `data/inbox/`.

## Replay (simulate daily arrival)

`replay --step` ingests the next brief from a directory that the volume does not hold yet, then exits.

```bash
scripts/replay.sh                 # one step from data/briefs
scripts/replay.sh 3               # three steps
scripts/replay.sh 1 data/inbox    # one step from data/inbox (after scripts/new_brief.py)
```

A seeded volume already holds every sample, so replaying `data/briefs` prints "nothing to do". To watch the archive grow from empty:

```bash
docker compose down -v                    # deletes the volume
SEED_DIR= docker compose up -d            # start without seeding
scripts/replay.sh                         # day 1; refresh the page; repeat
```

Once the volume is full, replay skips dates older than the oldest retained date, since they would be pruned at once.

## Rebuild the index

Run after changing `MAX_BRIEFS`, after upgrading the worker (render or index changes), or if `archive-index.json` looks wrong.

```bash
docker compose exec dashboard aegis-worker rebuild
```

`rebuild` re-prunes, re-indexes and re-renders every retained brief. Output is deterministic: same briefs, same bytes.

## Rotate and prune

Pruning is automatic. After every ingest the worker keeps the newest `MAX_BRIEFS` dates and deletes the rest from the volume. With `SYNC_TO_SUPABASE=1` it also deletes the pruned `briefs` rows and rendered pages in Supabase.

To change retention: set `MAX_BRIEFS` in `.env`, then `docker compose up -d` and run `rebuild`. Lowering it deletes the oldest dates. Raising it does not bring pruned dates back; re-ingest them.

## Back up and restore the volume

```bash
# Back up (read-only mount, safe while running)
docker run --rm -v aegis_volume:/v:ro -v "$PWD":/b alpine \
  tar czf /b/aegis-volume-$(date +%F).tgz -C /v .

# Restore into an empty volume
docker compose down
docker volume rm aegis_volume
docker volume create aegis_volume
docker run --rm -v aegis_volume:/v -v "$PWD":/b alpine \
  tar xzf /b/aegis-volume-YYYY-MM-DD.tgz -C /v
docker compose up -d
```

The volume is derived data. If you still have the brief JSON files, `aegis-worker ingest-dir <dir>` rebuilds it exactly. Backups are a convenience, not the only copy. `*.tgz` is git-ignored. Real-brief backups carry the briefs' TLP marking; store them accordingly.

## Rotate keys

The container holds `SUPABASE_ANON_KEY` (public) and `SUPABASE_SERVICE_KEY` (secret, only when syncing). Vercel holds only the anon key.

New-style keys (`sb_publishable_...`, `sb_secret_...`):

1. Supabase > Project Settings > API Keys. Create a new secret (or publishable) key.
2. Put it in `.env` on each device and `docker compose up -d`. For the anon key, also update the Vercel env var and redeploy.
3. Confirm sync works (ingest a brief, check the `briefs` table), then delete the old key.

Legacy JWT keys (`anon`, `service_role`): rotating the JWT secret replaces both keys at once and signs out every user. Update `.env` everywhere and Vercel, then redeploy.

Rotate at once if the service key ever lands in a browser, a log, a commit, or Vercel. `scripts/build_static.py` refuses to write a service key into `config.js`.

## Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| `retained: 0`, empty page | Volume created with `SEED_DIR` empty, or seed failed | `docker compose logs dashboard`; ingest with `aegis-worker ingest-dir /app/data/briefs` |
| `POST /api/ingest` returns 403 | `INGEST_ENABLED` is not 1 | Set it in `.env`, `docker compose up -d` |
| `POST /api/ingest` returns 422 | Brief fails the schema | Fix the brief. The response lists each problem. Run `python3 scripts/validate_briefs.py <file>` |
| `/api/archive` returns 401 | `REQUIRE_AUTH` on and no valid session token | Sign in on the page. Tokens are checked against Supabase `/auth/v1/user` |
| `/api/archive` returns 503 | `REQUIRE_AUTH=1` but Supabase URL or anon key missing | Set both, or set `REQUIRE_AUTH=0` |
| Port 8080 in use | Another service on the host | Set `HOST_PORT` in `.env` |
| Not reachable from another device | `BIND_ADDR=127.0.0.1`, or a host firewall | Set `BIND_ADDR=0.0.0.0`, open the port |
| Replay says "nothing to do" | Every file is already in the volume | Expected on a seeded volume. See Replay above |
| Sync warnings in logs, Supabase stale | `SYNC_TO_SUPABASE=1` with a missing or wrong service key, or migration not applied | Check `.env`; run `supabase/migrations/0001_init.sql`; ingest again |
| Vercel page shows demo data | `config.js` built without Supabase env | Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in Vercel, redeploy |
| Magic link opens the wrong site | Redirect URL not allow-listed | Supabase > Auth > URL Configuration, add the site URL |

# Deploy

Two deployments share one data contract.

| | Container | Static (Vercel) |
|---|---|---|
| Where | Any device with Docker: a laptop, a VM, a server | Vercel CDN |
| Data source | The volume, through the container API | Supabase tables, read with the reader's session |
| Needs Supabase | No. Optional for sign-in, feedback and settings sync | Yes |
| `window.AEGIS_CONFIG.mode` | `container` (injected by the worker) | `static` (from `apps/web/config.js`) |
| Ingest | `POST /api/ingest` or `aegis-worker ingest` | Through a worker with `SYNC_TO_SUPABASE=1` |

Before you start: real briefs carry TLP markings. The static path puts brief content in a cloud Supabase project. Confirm that is allowed for the markings in your briefs. The container path keeps everything on the device.

## 1. Create the Supabase project

Skip this section for a container-only deployment without sign-in.

1. Create a project at supabase.com. Pick a region close to readers. Save the database password.
2. Project Settings > API (or API Keys). Copy:
   - Project URL: `SUPABASE_URL`
   - Publishable or `anon` key: `SUPABASE_ANON_KEY` (browser-safe)
   - Secret or `service_role` key: `SUPABASE_SERVICE_KEY` (worker only, never in the browser or Vercel)

## 2. Apply the migration

Either way works. The file is safe to run more than once.

**SQL editor.** Open SQL Editor > New query. Paste all of `supabase/migrations/0001_init.sql`. Run.

**CLI.**

```bash
supabase init            # once, creates supabase/config.toml; keep the existing migrations folder
supabase link --project-ref <project-ref>
supabase db push         # applies supabase/migrations/*.sql
```

Check: Table Editor shows `briefs`, `archive_index`, `feedback`, `user_settings`, each with RLS enabled. Storage shows two private buckets, `rendered-briefs` and `feedback-screenshots`.

## 3. Turn on magic-link sign-in

1. Authentication > Sign In / Providers > Email. Enable the Email provider. Magic link (email OTP) is part of it.
2. Turn off "Allow new users to sign up" if only invited readers should get in. Then add readers under Authentication > Users > Invite.
3. Authentication > URL Configuration:
   - Site URL: the main reader URL, for example `https://aegis-brief.vercel.app`.
   - Redirect URLs: add every place the page runs:
     - `https://<your-vercel-domain>/**`
     - `http://localhost:8080/**`
     - `http://<device-ip-or-hostname>:8080/**` for each container device
4. The default email sender is rate limited. For more than a few readers, set custom SMTP under Authentication > Emails.

## 4. Load data into Supabase

Canonical: run the worker with sync on. It writes brief rows, uploads rendered pages, writes the archive index, and deletes rows for pruned dates.

```bash
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SERVICE_KEY=<secret key>
SYNC_TO_SUPABASE=1 aegis-worker ingest-dir data/briefs
```

Or set `SYNC_TO_SUPABASE=1` and `SUPABASE_SERVICE_KEY` in a container's `.env`. Every later ingest then syncs.

Fallback without the worker: `python3 supabase/seed.py`. It loads `briefs` rows only. The page builds the index itself when `archive_index` is empty. Pass `--index volume/archive-index.json` to upload an index the worker already made.

## 5. Create the Vercel project

1. Vercel > Add New > Project. Import this repository.
2. Leave Root Directory as the repo root. `vercel.json` sets:
   - Framework: none. No install step.
   - Build command: `python3 scripts/build_static.py`. It writes `apps/web/config.js` from env.
   - Output directory: `apps/web`. `/` rewrites to `/dashboard.html`.
3. Environment variables (Production and Preview):

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | Project URL |
   | `SUPABASE_ANON_KEY` | Publishable or anon key. `SUPABASE_PUBLISHABLE_KEY` also works. |
   | `REQUIRE_AUTH` | `1` (default). Leave it on for real briefs. |

   Do not add `SUPABASE_SERVICE_KEY`. The build refuses to write a service key into `config.js`, and nothing on Vercel needs it.
4. Deploy. Open the URL. You should see the sign-in screen.
5. Add the Vercel domain to the Supabase redirect URLs (step 3) if you have not.

On Vercel the page runs in static mode against Supabase only. There is no container, no `/api/*` and no `/briefs/<date>.html` route. New briefs appear when a worker with sync on ingests them.

The build fails on purpose when `SUPABASE_URL` or `SUPABASE_ANON_KEY` is missing. For a demo build with the embedded sample data, set the build command to `python3 scripts/build_static.py --allow-empty`.

`.vercelignore` keeps the worker, data, docs and Supabase files out of the upload. Only `apps/web` is served.

## 6. Run the container on another device

On the device (Docker Engine or Docker Desktop with Compose v2):

```bash
git clone <this repo> aegis-brief-dashboard && cd aegis-brief-dashboard
cp .env.example .env          # edit: Supabase values if used, BIND_ADDR, INGEST_ENABLED
export IMAGE_TAG=$(git rev-parse --short=12 HEAD)
docker compose build
docker compose up -d
curl -s http://localhost:8080/health
```

To build once and copy the image instead of building on the device:

```bash
# build machine
docker build -f services/worker/Dockerfile -t aegis-brief-dashboard:$IMAGE_TAG .
docker save aegis-brief-dashboard:$IMAGE_TAG | gzip > aegis-brief-dashboard-$IMAGE_TAG.tar.gz
# device (needs docker-compose.yml and .env from this repo)
gunzip -c aegis-brief-dashboard-$IMAGE_TAG.tar.gz | docker load
IMAGE_TAG=$IMAGE_TAG docker compose up -d --no-build
```

Build for the device's CPU. On an Apple Silicon Mac building for an x86 server, add `--platform linux/amd64`.

Exposure settings in `.env`:

- `BIND_ADDR=127.0.0.1` keeps the dashboard on the device. `0.0.0.0` (default) serves the local network.
- `INGEST_ENABLED=0` on any device reachable by people who should not post briefs. `/api/ingest` has no auth of its own.
- `REQUIRE_AUTH=1` with Supabase values set makes the data routes require a signed-in session.

Upgrade: pull, set the new `IMAGE_TAG`, `docker compose up -d --build`, then `docker compose exec dashboard aegis-worker rebuild`. The volume carries over.

## How auth and feedback flow

### Container mode, no Supabase

- `window.AEGIS_CONFIG` = `{mode: 'container', requireAuth: false}`. No sign-in.
- Data: `GET /api/archive` from the container.
- Feedback, my areas, stars, recently viewed, theme: browser storage on that device only.

### Container mode with Supabase

- The worker injects the Supabase URL and anon key. `requireAuth` defaults to true.
- The reader enters an email, gets a magic link, lands back on the container URL (it must be a listed redirect URL), and gets a session.
- The page calls `/api/archive` with the session token. The worker checks it against Supabase `/auth/v1/user` (cached 60 s) and returns 401 without one.
- Settings: `user_settings` row keyed by the user id (RLS: own row only). Browser storage stays as a cache.
- Feedback: screenshot to `feedback-screenshots/<user id>/...`, then a `feedback` row with `screenshot_path`. RLS allows insert and read of own rows and files only.
- With `SYNC_TO_SUPABASE=1` the worker also mirrors each ingest to Supabase with the service key.

### Static mode (Vercel)

- `config.js` sets `{mode: 'static', requireAuth: true}` and the Supabase URL and anon key.
- The reader signs in by magic link on the Vercel domain.
- Data: the page reads `briefs` and `archive_index` from Supabase with the session. RLS allows any signed-in user to read them and nobody else. If `archive_index` is empty, the page builds the index in the browser from the brief rows.
- Settings and feedback: same tables, bucket and policies as container mode.
- Reading feedback: as a project admin in the Supabase dashboard (Table Editor `feedback`, Storage `feedback-screenshots`). Readers cannot see each other's feedback.

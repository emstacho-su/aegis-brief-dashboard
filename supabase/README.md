# Supabase

Schema and loaders for the Supabase side of the dashboard. Spec: `docs/CONTRACT.md` section 6. Step-by-step setup: `docs/DEPLOY.md`.

## Files

| File | Purpose |
|---|---|
| `migrations/0001_init.sql` | Tables, grants, RLS policies, `updated_at` triggers, storage buckets and storage policies. Idempotent. |
| `seed.py` | Fallback loader. Upserts raw `briefs` rows (and optionally a worker-built `archive_index`). Needs `httpx`. |

## What the migration creates

| Object | Access |
|---|---|
| `briefs(date pk, data jsonb, updated_at)` | Signed-in users: select. Service key: everything. |
| `archive_index(id=1, data jsonb, updated_at)` | Signed-in users: select. Single row, enforced by `check (id = 1)`. |
| `feedback(id, user_id, created_at, page, bug, change, screenshot_path)` | Signed-in users: insert and select their own rows. `user_id` defaults to `auth.uid()`. |
| `user_settings(user_id pk, my_areas, stars, viewed, theme, updated_at)` | Signed-in users: select, insert, update their own row. Upsert works. |
| Bucket `rendered-briefs` (private) | Signed-in users: read. The worker writes `<date>/index.html` with the service key. |
| Bucket `feedback-screenshots` (private, images, 10 MB) | Signed-in users: upload to and read from `<their user id>/...` only. |

`anon` has no grants on any table. Grants are narrowed to match the policies, so a missing policy fails closed twice.

## Apply

SQL editor: paste the whole file and run. CLI: `supabase link --project-ref <ref>` then `supabase db push`.

Verified locally against Postgres 16 with stub `auth` and `storage` schemas: applies twice without error; anon is denied; users read briefs but cannot write them; users cannot insert feedback for another user, read another user's settings or feedback, or upload outside their own folder.

## Load data

Canonical (worker does validation, render, index, prune and sync):

```bash
SYNC_TO_SUPABASE=1 SUPABASE_URL=... SUPABASE_SERVICE_KEY=... aegis-worker ingest-dir data/briefs
```

Fallback (raw rows only):

```bash
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python3 supabase/seed.py
python3 supabase/seed.py --dry-run     # validate and list, no network
python3 supabase/seed.py --help
```

Both read keys from the environment only. Neither prints them.

## Auth email template (required)

The dashboard signs people in with a 6-digit code, not a link. Mail-security scanners (Defender Safe Links on
Microsoft 365 tenants such as syr.edu) fetch every URL in an email before delivery; fetching a Supabase magic link
redeems it, so the reader finds a dead link. A code is inert until typed. The link and the code are the same
underlying one-time token, so the email must contain only the code.

In the dashboard: Authentication, Email Templates, Magic Link. Subject `Your AEGIS sign-in code`, body from
`supabase/templates/magic-link.html`. Leave the other templates alone; the app only uses this one.

Also set custom SMTP (Authentication, SMTP Settings) before inviting anyone: the built-in mailer allows two emails
per hour per project. Once SMTP is on, raise the email rate limit under Authentication, Rate Limits.

## Reviewing feedback

Every entry a signed-in reader submits with the + control is a row in `public.feedback` (`user_id`, `page`, `bug`,
`change`, `screenshot_path`, `created_at`); the screenshot is an object in the private `feedback-screenshots`
bucket at `screenshot_path` (`<user id>/<timestamp>.jpg`). Readers can only see their own rows (RLS).

To read everything with the submitter's email, use the `feedback_review` view (migration 0002) from the SQL editor:

```sql
select created_at, email, page, bug, change, screenshot_path
from public.feedback_review
order by created_at desc;
```

Open a screenshot from Storage, bucket `feedback-screenshots`, by its path. The view is not exposed through the
API to anon or authenticated roles; only the dashboard (postgres) and the service key can read it.

## Adding a user

Authentication, Users, Add user, Create new user: their email, auto-confirm on. Whatever password you type there is a
placeholder; the dashboard never lets it in. The user's first visit is: "Email me a one-time code", enter the code,
then a mandatory "Set your password" card (migration 0003, `user_settings.pw_set`). After that they sign in with
email + password; the code path doubles as password recovery. Keep "Allow new users to sign up" off, set Minimum
password length to 12, and turn on "Prevent use of leaked passwords" (Authentication, Sign In / Providers, Email).

## Per-user state

`my areas`, stars, recently viewed and theme live in `public.user_settings`, one row per user, pulled on every
sign-in and written back (debounced) on every change, so they follow the user across browsers and sessions. The
page's browser cache is namespaced by user id, so two people sharing a browser never see or seed each other's
state; a first sign-in on a new browser starts from the user's own row (or empty), never from the cache.

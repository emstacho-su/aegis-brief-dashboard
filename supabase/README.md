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

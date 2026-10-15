# apps/web: AEGIS Daily Brief dashboard

One self-contained page, `dashboard.html` (no build step, no framework). It renders Home, Area, Brief, Trends, Archive and the item popout from an archive of daily brief JSON files. Data shapes, routes and the Supabase schema are defined in [`docs/CONTRACT.md`](../../docs/CONTRACT.md); this file only covers how the page picks its data source and what it expects from its hosts.

## Three modes

At startup the page reads `window.AEGIS_CONFIG` and loads its data before the first render. The ribbon in the header shows `v1.3.3 · <n> briefs · <mode>`.

| Mode | When | Data comes from |
|---|---|---|
| `container` | `mode: 'container'`, or a config with `apiBase` set (including `''`) and no explicit mode | `GET ${apiBase}/api/archive` returning `{briefs, index, manifest}` (CONTRACT section 4). The server `index` is used when it covers exactly the returned dates; otherwise the page computes it with its own `buildIndex`. The Archive view links each date to the stored render at `${apiBase}/briefs/<date>.html`. |
| `static` | `mode: 'static'`, or a config with `supabaseUrl` and no `apiBase` | Supabase tables `briefs` (`select date,data`, ordered by date) and `archive_index` (`id = 1`, column `data`), read with the signed-in user's session. No container API. |
| `sample` | no config at all | `ARCHIVE_JSON` if a script defines it before the page script (shown as `local`, or `sample` when `ARCHIVE_META.sample` is set), otherwise the embedded synthetic generator. This keeps the file reviewable straight from disk. |

While loading, `#main` shows a skeleton of the Home layout with a spinner and the status line (v1.6.0); if the load fails (HTTP error, network, empty archive, Supabase error) it shows an error banner with a Retry button instead of a blank page.

## Config

```js
window.AEGIS_CONFIG = {
  apiBase: '',                 // container mode: prefix for /api/archive and /briefs/<date>.html ('' = same origin)
  supabaseUrl: '',             // enables magic-link auth, settings sync and the team feedback store
  supabaseAnonKey: '',
  requireAuth: false,          // true: every view is behind a Supabase session
  mode: 'container',           // 'container' | 'static'
  allowSignup: false           // optional; false sends magic links only to existing users (invite only)
};
```

Two ways to supply it, and the inline one wins:

1. **Static hosting:** copy `config.example.js` to `config.js` beside `dashboard.html`. The page includes `<script src="config.js"></script>` before its main script; a missing file is a harmless 404.
2. **Container (worker):** when serving `/`, the worker replaces the exact marker line

   ```html
   <!-- AEGIS_CONFIG_INJECT -->
   ```

   with an inline script, for example

   ```html
   <script>window.AEGIS_CONFIG={"apiBase":"","supabaseUrl":"https://xyz.supabase.co","supabaseAnonKey":"eyJ...","requireAuth":true,"mode":"container"};</script>
   ```

   Serialize with a JSON encoder and escape `<` as `<` so a value can never close the script tag. The marker sits after the `config.js` tag, so the injected config overrides a `config.js` if one exists. The worker can 404 `/config.js`.

## Sign-in (Supabase magic link)

Only when `supabaseUrl` and `supabaseAnonKey` are set, the page loads `@supabase/supabase-js@2.45.4` (UMD, jsDelivr, with a Subresource Integrity hash).

- `requireAuth: true`: with no session the page shows a sign-in card (email + password via `auth.signInWithPassword`, or the code path below). The code path sends `auth.signInWithOtp({email, options: {emailRedirectTo: origin + pathname, shouldCreateUser: allowSignup}})`, then shows a code field and calls `auth.verifyOtp({email, token, type: 'email'})` with the numeric code from the email (6 to 10 digits; the project sets the length) (the Magic Link template must carry `{{ .Token }}` and no link; see `supabase/README.md`). After any sign-in the page reads `user_settings.pw_set`; when false it blocks the app behind a set-password card (`auth.updateUser({password})`, 12+ chars) and then sets `pw_set`. "Change password" is in the account menu, and loads data only once a session exists. The link returns tokens in the URL hash; supabase-js consumes them and the page resets the route to `#home`. An expired or invalid link shows its error on the sign-in card. Opening the link in another tab of the same browser also signs in the waiting tab.
- `requireAuth: false`: anonymous viewers see the dashboard as before; the account menu offers "Sign in" so they can sync their settings.
- Signed in: the avatar shows the first letter of the email, the account menu shows the email and a working Sign out (local scope).

Supabase project settings this needs: Email auth with magic links enabled; the page URL (for example `https://aegis.example.edu/` and `http://localhost:8080/`) in Auth > URL Configuration > Redirect URLs. With `allowSignup` false, add users by invitation (Auth > Users > Invite) or the admin API.

## What the page reads and writes in Supabase

All calls go through supabase-js with the user's session, so RLS applies (CONTRACT section 6).

| Object | Operation | Columns or path |
|---|---|---|
| `briefs` | select (static mode) | `date`, `data` |
| `archive_index` | select `id = 1` (static mode) | `data` |
| `user_settings` | select own row; upsert `onConflict: user_id` (debounced 300 ms) | `user_id`, `my_areas` (string array), `stars` (string array), `viewed` (string array, max 12), `theme` (`dark`, `light` or `system`), `updated_at` |
| `feedback` | insert | `user_id`, `page`, `bug`, `change`, `screenshot_path` |
| bucket `feedback-screenshots` | upload, `contentType: image/jpeg`, no upsert | `<user_id>/<epoch ms>.jpg` |

Settings: on sign-in the account row wins and is written to localStorage, which stays the fallback and a write-through cache; with no row yet, the browser's current settings seed it. Writes never block rendering. Feedback: the local list (review panel, Copy as JSON) keeps working; when signed in, Save also uploads the screenshot and inserts the row, then shows "Saved to the team store" or the error.

In container mode with a session, `/api/archive` is requested with `Authorization: Bearer <access token>`; the worker may verify it but does not have to.

## Test locally

Against the worker (container mode):

```sh
aegis-worker ingest-dir data/briefs
aegis-worker serve            # http://localhost:8080
```

Open http://localhost:8080. The ribbon should read `v1.3.3 · 22 briefs · container`, and Archive rows should have "Open stored page" links. To test sign-in, start the worker with `SUPABASE_URL` and `SUPABASE_ANON_KEY` set and add `http://localhost:8080/` to the Supabase redirect URLs.

Static mode: copy `config.example.js` to `config.js`, fill in the project URL and anon key, and serve the folder over HTTP (`python3 -m http.server 8000` in `apps/web/`, then open `http://localhost:8000/dashboard.html`). Magic links do not work from `file://`.

From disk with no config: open `dashboard.html` directly; it renders the synthetic sample.

Headless smoke test (Node 18+, no dependencies): renders every view and popout in sample, container (with and without a server index), failure, single-brief and static-with-auth modes against stubs:

```sh
node apps/web/test-harness.js            # uses data/briefs
```

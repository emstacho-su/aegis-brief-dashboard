# scripts/ux-audit: drive the dashboard in a real browser

`drive.js` runs a JSON list of browser steps against a running dashboard (a container, `scripts/dev.sh`, or any
URL that serves `dashboard.html`) and writes screenshots plus a result JSON with every console error, page error,
failed request, page title and horizontal-overflow measurement. It is the instrument the October 2026 UX audit used:
six agents, each owning one slice of the page, drove isolated containers with it and judged the screenshots.

It is not a test suite. The regression tests live in `apps/web/test-harness.js` (DOM stub, no browser) and
`apps/web/tests/browser-*.js` (Playwright against `dashboard.html` from disk). Use this when you want to look at
the real page under a given sequence of actions, or to re-audit after a change.

## Setup

```sh
cd scripts/ux-audit
npm install                 # installs Playwright; first run also downloads Chromium
npx playwright install chromium
```

Playwright is a dev-only dependency of this directory, not of the project. Nothing in CI runs it.

## Run

```sh
node drive.js steps/smoke.json --base http://127.0.0.1:8080 --out results/smoke.json
```

Options: `--base URL` (origin of the running page), `--viewport WxH` (default 1280x800), `--theme dark|light`
(emulated `prefers-color-scheme`), `--profile NAME` (persistent browser profile under `profiles/`, keeps
localStorage between runs), `--shots DIR` (default `shots/`), `--timeout MS` (default 8000 per action),
`--continue` (keep going after a failed step), `--headed` (watch it).

Windows note: native `node` needs `C:/...` paths, not `/c/...`.

## Steps

A steps file is a JSON array, or `{"base":..,"viewport":..,"theme":..,"steps":[..]}`. Each step is an object with
`op` and fields:

| op | fields | notes |
|---|---|---|
| goto | url | `#home`, `/briefs/2026-09-29.html`, or an absolute URL. Waits for the page to boot or to show a sign-in card or error banner. Returns `{url, booted}`. |
| reload, back | | same wait as goto |
| viewport | w, h | |
| theme | scheme: dark/light | emulates `prefers-color-scheme` |
| click | sel, nth?, force?, popup? | `popup: true` follows a `target=_blank` link; later steps run in the new tab until `close-popup` |
| dblclick, hover, focus, blur, scroll (sel or y) | sel | |
| fill | sel, value | sets an input's value |
| type | sel, text, delay? | real keystrokes (use for the search box so input events fire) |
| press | key, sel? | `Escape`, `Tab`, `Enter`, `ArrowDown`, … |
| drag | from: [x,y], to: [x,y] | mouse drag (feedback capture box) |
| mouse | action: move/click/down/up, at: [x,y] | |
| wait | ms, or sel (+state), or fn (JS expression) | |
| eval | js | a JS expression evaluated in the page (use an IIFE for statements) |
| text, html, count, attr (name), visible, box | sel | read the DOM |
| aria | sel? | aria snapshot of a region (default body) |
| storage | | dumps localStorage |
| metrics | | hash, title, scrollWidth, innerWidth, `hscroll` (horizontal page overflow), theme, focused element |
| shot | file, sel?, full? | full-page PNG by default; `sel` crops to an element; returns the file plus the metrics |

The `storage` step dumps every localStorage key into the result file. On a Supabase-enabled instance that includes the
signed-in session token, so treat `results/` as sensitive (it is gitignored) and do not share a result that used
`storage` against a real sign-in.

Every step record carries `ok`, `ms`, `title` and `url`. The result also lists every console error and warning,
page error, failed request and 4xx/5xx response with the step index it happened on. Exit code 0 when every step
passed, 1 otherwise.

## Re-auditing

Build an image from a clean export (on Windows use `git -c core.autocrlf=false archive`), run one container per
slice on its own port and volume (`docker run -d -p 127.0.0.1:8081:8080 -v aegis_ux_shell:/var/lib/aegis/volume …`),
write one steps file per scenario, and open the screenshots. Useful variants: `-e SUPABASE_URL=https://ux-stub.invalid
-e SUPABASE_ANON_KEY=x` for the sign-in surface, `-e SEED_DIR=` for an empty archive, and `-e SEED_DIR=` followed by a
single `POST /api/ingest` for a one-brief archive. The audit's slices were: shell and navigation; Home and Area views;
Daily brief and item popout; Trends; Archive, stored pages, search and feedback; sign-in and edge states.

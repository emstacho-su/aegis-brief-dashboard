# Changelog: dashboard page

Design-cycle notes for `apps/web/dashboard.html`. These used to ship inside the page behind a "Design notes" toggle in the account menu; they were moved here in v1.3.1 so readers never see them.

## v1.3.3 · code length

The code field accepts 6 to 10 digits; the Supabase project sends 8-digit codes (Email OTP Length). Copy no longer says "6-digit".

## v1.3.2 · sign-in by code

Sign-in is a two-step card: email, then a 6-digit code (`verifyOtp`, type `email`). Links were being redeemed by Microsoft Defender Safe Links on the syr.edu tenant before delivery, so readers only ever saw expired links. The Supabase Magic Link template now carries only `{{ .Token }}`. "Send a new code" and "Use a different email" on the code step; rate-limit and bad-code errors have their own wording.

## v1.3.1 · rail wrap and notes removal

Two-column pages measure the item column against the rail after render; when the rail would run more than 120px past the items it wraps into an auto-fill grid beneath them (120px hysteresis). The in-page design notes toggle was removed; this file replaces it.

## v1.3 · data adapter and sign-in

The page loads its archive at startup from the container API (`/api/archive`) or, on static hosting, from the Supabase tables, chosen by `window.AEGIS_CONFIG`. With no config it falls back to the embedded sample. When sign-in is required, every view sits behind a Supabase magic link; signed-in viewers keep my areas, stars, recently viewed and theme in their account (browser storage stays as a cache), and feedback is saved to the team store. The ribbon names the data mode.

## v1.1.1 · collapsible home sections

The relevance tab row and the Activity stream header highlight on hover like sidebar items; clicking their blank area collapses the content beneath them (tab buttons and the area filter still work). Collapsed state is remembered per browser; a hidden keyboard toggle appears on focus.

## v1.1 · chart language

Charts follow the Sprout Social reference: KPI tiles with an arrow and percent change versus the previous period of equal length on every report and on the Trends landing; smoothed lines with a dotted moving-average series and an end dot; grouped bars (this period vs previous) for Items by area and Source contribution; ranked horizontal bars with the total at the right; a tooltip listing every series for the hovered day or mark (also on keyboard focus); the report title and question inside the chart card. Period is measured in briefs, so gaps in the archive do not distort it.

## v1.0 · themes and accessibility

- Light and dark themes. Dark stays the design-system default; light follows the OS or the Theme control in the account menu. Light mode uses SU blue (the reserved --su-blue token) for every interactive accent; the orange header border and brand pipe stay in both themes. Each token set was checked against WCAG 2.1 AA: text 4.5:1 or better on every surface, control borders and chart marks 3:1 or better. Muted text and the control border were lifted from the canonical values, which is a design-system change request.
- Keyboard: skip link, every chart mark, context bullet, timeline icon and card is focusable with a visible 3px focus ring; Enter and Space activate; Esc closes menus, popouts, tooltips and capture; focus returns to the opener when a popout closes.
- Screen readers: landmarks, aria-current in the sidebar, accessible names on icon-only buttons and score rings, live announcements for saves and theme changes, page titles per route, data tables under every chart.
- Feedback capture has keyboard paths (capture the visible screen, or skip the screenshot).

## v0.9 · cycle 5

- Sidebar collapses by clicking any blank space in it; no visible toggle (a hidden one appears for keyboard focus).
- + in the top bar: drag a box around a bug, the page region is captured (in-page DOM capture, no OS snipping tool), then a form asks what the bug is and what should change. Saved in this browser; the avatar menu lists captures and copies them as JSON until a shared store exists.
- Sidebar area counts are the grey number of active items. Trends is a plain link to the report catalog.
- Home and Area now work across the volume: an item is active if it appeared in any of the last 7 briefs. Carried items (active but not in today's brief) show a dashed "Last mm-dd" pill and sit after today's items in My areas, in the Area view, and in the area cards' counts.

## v0.8 · sidebar

Sidebar collapses to a 56px icon rail (toggle at the top, remembered per browser); every item has a white line icon; "Today's brief" is a bold text item under "Your work" instead of a button. In the rail, a group icon navigates to that group's main view.

## v0.8 · timeline

Popout timeline rebuilt on the Pipedrive contacts-timeline pattern: month headers, a track with continuous-run segments, circular icons pinned to the track (★ first brief, ≡ each brief with ring color = tier, CVE published below the track, ! escalation), TODAY line, hover tooltips with a snippet, hover-anywhere date cursor, dates under each icon on two staggered rows, horizontal scroll at 28px per day for long spans.

## v0.7 · cycle 3 changes

- Sidebar navigation (Mailchimp pattern): primary action, accordion groups for Briefs, Areas, Trends; current page highlighted; collapses to a drawer under 900px.
- Top bar: item search across the archive, version tag, account avatar with a menu (my areas, starred, recently viewed, design notes, reset). Sign-in or device detection to come.
- Page TLP badge removed from the header.
- Popout: one item-detail card (what it is, analysis, delta, SU impact, recommended actions); metadata as a short full-width strip.

## v0.5 · cycle 2 changes

- Home: tabs and activity stream are full width, stream below the tabs.
- Area cards: red tint when the area has a Tier 1 item today; a corner ! (hover for the count) when it has more than one.
- Daily brief: a "Relevant to my areas" card row above the list and actions; cards open the popout directly.

## v0.4 · the higher level

Jira "Your work" shape: area cards (rail = highest priority in the area today, quick links with counts, 30d sparkline), relevance tabs (My areas, New today, Escalations, Recently viewed, Starred), activity stream derived from the archive. Today's brief is now one level down.

## Levels and clicks

- Home → area card (1) → item card expand (2) → popout (3) → source (4). Or Home → tab row → popout (2).
- Trends → report (1) → chart mark (2) → listed item popout (3).
- Archive → day (1) → brief → item (2) → popout (3).

## What the archive computes

Per item: first seen, days in brief, tier and score history, escalation days, dropped. Per day: counts, new, dropped, average ages. Events: new, returned, promoted, demoted, score jump (≥15), escalated, dropped, action raised, action closed. None of it is model-authored.

## Assumptions to confirm

- Area taxonomy (nine environment domains) is a placeholder; items can belong to more than one.
- "Dropped" means absent from the brief, never "resolved".
- Viewer state (my areas, stars, recently viewed) is per browser; no accounts in Phase 3.
- The 30-day volume must keep the per-day JSON, not only HTML, for any of this to work.

## Synthetic data

36 fictional items with scripted lifecycles over 30 days (2026-09-16 to 10-15), one invalid-schema day (09-23), periodic stale feed. Real briefs replace this in the next step.

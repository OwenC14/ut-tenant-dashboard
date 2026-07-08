# UT Tenant Savings Dashboard

Pulls generation/battery/grid data from each property's Fox ESS inverter (Fox Open
API) and shows tenants their solar/battery/grid usage split and bill savings.

Full spec: [`docs/UT_Tenant_Dashboard_Spec.md`](docs/UT_Tenant_Dashboard_Spec.md).

## Status

Build order (spec §10):

- [x] 1. Scaffold repo, Postgres schema, deploy skeleton
- [x] 2. Fox OAuth flow for one test device
- [x] 3. Poller for one device
- [x] 4. Nightly rollup job + cost calculation
- [x] 5. Dashboard API + minimal frontend
- [x] 6. Multi-tenant isolation (second/third property)
- [x] 7. Onboarding flow at scale
- [x] 8. Organizations model + HA/LA portfolio view
- [x] 9. Agreements/consent_records sign-up flow

All nine build-order steps from spec §10 are complete. See "Known gaps before
real go-live" below for what still needs real (non-placeholder) input from UT.

## Stack

Node.js + TypeScript, Express, Postgres (`pg`), deployed on Render (`render.yaml`).
See spec §3 for rationale.

## Setup

```bash
npm install
cp .env.example .env   # set DATABASE_URL to a local/managed Postgres instance
npm run migrate         # applies migrations/*.sql
npm run dev              # starts the API on PORT (default 3000)
```

`GET /health` checks the process is up and the DB is reachable.

## Fox OAuth flow (spec §4.1)

- `GET /oauth/fox/authorize?propertyId={id}` — redirects to Fox's consent page for
  that property. Requires the property to already exist in `properties`.
- `GET /oauth/fox/callback` — Fox redirects here with `code`/`state` after consent;
  exchanges the code for tokens and stores them (encrypted, see below) against the
  property.
- `npm run refresh-tokens` — refreshes any property's tokens expiring within the
  next hour (spec §4.1 point 5: refresh is scheduled, not on-demand). Point Render's
  cron job service at this once deployed.

`ENCRYPTION_KEY` (`openssl rand -base64 32`) encrypts `fox_access_token` /
`fox_refresh_token` at rest (AES-256-GCM, spec §8) — never store or log them in
plaintext.

Fox's public OAuth docs (linked in the spec) don't give a fully explicit token
response schema — `src/fox/client.ts` currently assumes standard OAuth2 field names
(`access_token`, `refresh_token`, `expires_in`) and endpoint paths (`/oauth2/token`,
`/oauth2/refresh`). Confirm both against Fox's sandbox/Postman collection the first
time this runs with a real `client_id` — that one file is the only thing that should
need to change if they differ. The flow itself (redirect, state/CSRF check, token
exchange, encrypted storage, refresh) has been verified end-to-end locally against a
mock Fox server standing in for foxesscloud.com.

## Poller (spec §4.2, §4.3)

`npm run poll` — for every property with a stored Fox access token, queries the
`/op/v0/device/report/query` report endpoint for `generation`/`loads`/`feedin`/
`gridConsumption`/`chargeEnergyToTal`/`dischargeEnergyToTal`, sums the day's hourly
points, and writes one `meter_readings` row. Runs the §4.2 reconciliation check
(`loads` ≈ solar self-consumed + battery discharge + grid consumption) and logs a
warning — doesn't fail the poll — when a property's numbers don't add up, since
that's usually a meter/CT clamp misconfiguration rather than a real usage pattern.

Sequential with a ~1.1s gap between properties to respect Fox's 1 req/sec cap — fine
at pilot scale (≤200 devices, §2); a job queue replaces this at 20k devices.

Same caveat as the OAuth client: Fox's public docs don't fully confirm whether the
report endpoint's hourly datapoints are increments or a running total, or the exact
OAuth-mode request signing — `src/fox/reportClient.ts` assumes increments (sums
them) and carries the signing scheme from the docs. Verify against a real device the
first time this runs live and adjust that one file if needed. Verified locally
end-to-end against a mock report endpoint, including the reconciliation-mismatch
warning path.

## Nightly rollup (spec §5, §10 step 4)

`npm run rollup [YYYY-MM-DD]` — aggregates each property's last `meter_readings` row
of the day (a cumulative-for-the-day snapshot) into one `daily_rollups` row, with
cost figures computed using the *exact* formulas from
`docs/UT_Phase1_Tenant_Calculator.html`'s `render()`, just fed the real solar/
battery/grid split instead of a slider-derived estimate:

```
currentBill = consumption * gridCapRate + standingChargeDaily
newBill     = batteryCoveredKwh * offpeakRate + gridCoveredKwh * gridCapRate + standingChargeDaily
saving      = currentBill - newBill
```

Tariff rates live in `tariff_rates` (effective-dated, not hardcoded — Ofgem's price
cap changes quarterly, §5) seeded with the calculator's current Jul-Sep 2026 rates.
Add a new row with a future `effective_from` each time Ofgem's cap changes; past
rollups keep using the rate that was live at the time. Upserts on `(property_id,
date)`, so re-running a date is safe if raw readings get reprocessed. Defaults to
yesterday (UTC) for the nightly cron; pass a date to backfill/reprocess.

## Tenant auth + dashboard (spec §7, §8, §10 step 5)

Magic link via email — deliberately separate from the Fox OAuth token (§8: a
tenant logging into their UT dashboard is a different credential from their Fox
account).

- `POST /auth/magic-link { email }` — if `email` matches a property's
  `tenant_email`, emails a 15-minute single-use login link. Responds identically
  whether or not the email matches, so it can't be used to enumerate onboarded
  tenants.
- `GET /auth/verify?token=...` — consumes the link, sets an httpOnly session
  cookie (30 days), redirects to `/dashboard.html`.
- `GET /api/dashboard?range=24h|week|month|year` — requires the session
  cookie; returns only the authenticated tenant's own usage data
  (property-scoped at the query, never trusts a client-supplied property id).

No real email provider is wired up yet (`src/lib/mailer.ts` just logs the link) —
swap that one function for Postmark/SES/Resend/etc. before onboarding real
tenants.

The four range options (§7) are trailing windows ending at the most recent
data point for the property, not literally "today"/"this hour" — `week`
(7 days), `month` (28 days) and `year` (365 days) are `daily_rollups`
aggregations; `24h` is genuinely hourly, built from raw `meter_readings` (see
"Property health status, filters & sorting, time ranges" below for how the
hourly bucketing works). Defaults to `month` on first load per spec (a single
day's weather is a misleading first impression). Per-day/per-hour cost
breakdown (solar saving / battery off-peak cost / grid cost, in £) is
recomputed from `tariff_rates` at query time rather than stored, so it stays
correct across a tariff change mid-range.

`public/` is the minimal frontend — plain HTML/CSS/JS (no framework, matching
§3/§7's "reuse the calculator's HTML/CSS/JS pattern"), served as static files by
Express. `style.css` is the calculator's palette and card/bill-compare/bar/legend
components lifted directly from `docs/UT_Phase1_Tenant_Calculator.html` so the
dashboard reads as its "real data" sibling. `manifest.json` + `sw.js` give it
basic PWA installability (§9b) — real UT logo assets for the header and home
screen icon aren't available yet, so it currently reuses the calculator's own
text/colour-mark fallback rather than a fabricated logo; drop real icons into
`public/` and reference them in `manifest.json` when available.

Verified end-to-end locally: magic-link request → email-log capture → link
verify → session cookie → all four ranges returning correctly-aggregated,
property-isolated data (checked against hand-computed totals from synthetic
`daily_rollups` rows) → rendered dashboard and login pages screenshotted in a
real browser → unauthenticated `/api/dashboard` request confirmed to 401.

## Multi-tenant isolation (§10 step 6)

No dedicated isolation code was needed — by construction, every tenant-facing
route derives `propertyId` from the session (`req.propertyId`, set by
`requireSession`) and never from a client-supplied parameter, so there's no
request shape that lets one tenant address another's property.

Verified anyway, empirically, with three properties on distinct Fox devices and
distinct tenant emails: polled and rolled up independently (confirmed each
property's `meter_readings`/`daily_rollups` hold its own device's numbers, not
mixed or overwritten), then logged in as all three tenants concurrently and
confirmed each session's `/api/dashboard` returns only that property's figures.
Also confirmed a consumed magic-link token can't be replayed for a second
session.

## Onboarding (spec §9 decision 1, §10 step 7)

`/admin/*` — property onboarding:

- `POST /admin/properties` — create one property; returns its id, a
  ready-to-share Fox consent link (`GET /oauth/fox/authorize?propertyId=...`),
  and a `signupCode` for the tenant (see "Tenant self-signup" below).
- `POST /admin/properties/bulk { properties: [...] }` — create many in one call
  ("at scale", §10 step 7) without needing a CSV parser; one bad/duplicate row
  reports an error for that row without aborting the rest of the batch.
- `GET /admin/properties` — list every property with onboarding status (Fox
  linked? tenant email set? last reading/rollup?) so install staff can see
  what's still outstanding across the pilot's 100-200 properties.
- `public/admin.html` — a UI over the same API: a form to add a property and a
  table of onboarding status, including each property's signup code and Fox
  consent link.

Per-property install/commissioning order (§4.1, §9 decision 1): (1) confirm or
create the tenant's Fox Cloud account — the OAuth consent flow depends on it
existing; (2) install the hardware and note the device serial number; (3) add
the property via `/admin/properties` (tenant email optional now — see
self-signup below); (4) send the tenant the Fox consent link to link their
device, and their signup code so they can set up their own dashboard account.
Deliberately not gated on any consent/agreement step yet — that's step 9,
sequenced after onboarding on purpose (§10).

### Admin accounts (Super Admin / Operations / Installer)

Three-tier accounts, `admin_users` (migration `006_admin_users.sql`, tiers
updated by `009_admin_tiers_v2.sql`), authenticated the same magic-link way as
tenants and org users (`/admin-auth/magic-link`, `/admin-auth/verify`,
`public/admin-login.html`) — no more shared key for day-to-day use:

- **Super Admin** — access to every client, can create new clients
  (`POST /admin/organizations`), reassign a property between clients
  (`PATCH /admin/properties/:id/organization`), manage the team
  (`GET/POST /admin/team`, `DELETE /admin/team/:id`), and assign operations/
  installer staff to clients (`GET/POST /admin/organizations/:id/assignments`,
  `DELETE .../assignments/:adminUserId`).
- **Operations** — full onboarding/management access (add properties, batch
  import, invite portfolio users), but only for whichever clients they've
  been assigned in `admin_client_assignments` — `src/auth/adminScope.ts`'s
  `resolveAdminClientScope()` resolves this per request and every `/admin/*`
  route filters or 403s accordingly. Can't create new clients or reassign a
  property to a client outside their scope.
- **Installer** — read-only, scoped the same way as Operations. An installer
  with *no* client assignments is treated as a Union Technical installer and
  sees every client (the spec's stated exception) — one with assignments is
  scoped to just those. `blockInstallerWrites` middleware 403s any
  POST/PATCH/DELETE for this role regardless of scope.

`public/admin.html` reflects all of this: the "Add organization" form and
Team card are Super-Admin-only; "Add a property"/CSV import are hidden for
Installers; missing postcode/tenant-email fields show a plain `—` instead of
a clickable "+ add" for Installers (who'd just get a 403 clicking it); and
the clients table shows/edits each client's assigned staff (Super Admin
only — everyone else sees a read-only list).

`ADMIN_API_KEY` still exists as a **break-glass/bootstrap credential** — it's
always treated as `super_admin` on `requireAdmin`-protected routes. Since
creating an `admin_users` row normally requires already being a super admin,
this key is how the very first one gets created:

```bash
curl -X POST https://<host>/admin/team \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Sarah Ahmed","email":"sarah@uniontechnical.co.uk","role":"super_admin"}'
```

After that, Sarah signs in normally at `/admin-login.html` and invites everyone
else from the Team members section. Keep `ADMIN_API_KEY` secret and rotate it
if it's ever exposed — treat it like a root password, not a daily-use credential.

### Tenant self-signup

Properties get a random `signup_code` (`UT-XXXXX`, migration `007_signup_codes.sql`)
when created — visually unambiguous characters only (no `0`/`O`, `1`/`I`), since
install staff hand-write it on the tenant's welcome paperwork. `tenant_email`
can now be left blank at onboarding time and set by the tenant themselves:

- `POST /auth/signup { code, email }` (`public/signup.html`, linked from the
  login page) — claims the property matching that code, sets `tenant_email`,
  and immediately sends a login link (signup and first login are one
  continuous flow, same as clicking "sign in" afterwards would). Refuses with
  `already_claimed` if the property already has an email set — the code can't
  be used to hijack an existing tenant's account, only to claim an unclaimed one.
- No rate limiting on this endpoint yet — the code space (~33M combinations)
  resists casual guessing but this needs closing before real go-live (see
  "Known gaps" below).

Verified end-to-end locally: master-key bootstrap of the first super admin,
Super Admin inviting an Install Staff member, Install Staff correctly blocked
(403) from `/admin/team` but able to onboard a property, tenant self-signup
with that property's code, rejection of both an invalid code and a re-used
(already-claimed) code, and the resulting tenant landing at the same
`app_terms` gate any other tenant would — all checked via curl and real-browser
screenshots of both admin roles' views.

## HA/LA portfolio view (spec §9a, §10 step 8)

`organizations` / `organization_users` / `properties.organization_id` (§9a.2).
Org users authenticate the same way tenants do — magic link via email — but
through a separate `/org-auth` + `org_sessions` pair, so an org session token
can never resolve to a `propertyId` or vice versa (isolation "one level up",
§9a.3).

- `GET /portfolio/summary?range=24h|week|month|year` — requires an org session;
  aggregates *every* property assigned to that org's `organization_id` over
  the selected trailing window (§9a.3: aggregate totals include all
  properties regardless of consent status, since a sum/average doesn't
  identify an individual tenant). Also returns a per-property list with a
  `status` + `requiredActions` (see "Property health status" below) and
  `drilldownAvailable`.
- `public/portfolio-login.html` + `public/portfolio.html` — minimal frontend,
  same visual system, showing the aggregate bill-compare/bar/legend plus the
  property list.
- Admin-side: `POST /admin/organizations`, `POST /admin/organizations/:id/users`,
  `PATCH /admin/properties/:id/organization` — same shared-admin-key API as
  onboarding (step 7).

**`drilldownAvailable` was hardcoded `false` for every property when this
section was first built (step 8) — the real check, and the drill-down
endpoint itself, were added in step 9 below once `consent_records` existed.**
The build order deliberately sequences organizations before agreements so
drill-down could never ship without a real consent gate behind it.

Verified end-to-end locally: two organizations, cross-org isolation (org B's
session sees zero of org A's three properties), portfolio totals summing only
properties with rollup data while the property list still includes the one
with none, and the stale property (5-day-old reading, no rollup ever)
correctly flagged — checked in a real browser via screenshot.

## Consent flow (spec §9a.4, §10 step 9)

`agreements` (versioned, `effective_from`-dated) + `consent_records`
(append-only — every accept/decline/withdraw is a new row, never an overwrite).
A property's current status for an agreement type is always "the most recent
`consent_records` row for that `property_id` + the *current* `agreement_id`" —
queried live in `src/consent/agreements.ts`, never cached.

- `GET /api/consent/status` — current `app_terms` and `ha_data_sharing` status
  (plus document text) for the authenticated tenant.
- `POST /api/consent/:type { status }` — records a decision against the
  current agreement for that type. `app_terms` only accepts `status: accepted`
  (spec §9a.4 point 1: it's an accept-to-continue gate, no decline path).
  `ha_data_sharing` accepts `accepted` / `declined` / `withdrawn` (point 2: a
  real, recorded decline that doesn't block anything, and a later change of
  mind either direction).
- `GET /api/dashboard` now 403s with `app_terms_not_accepted` until the tenant
  accepts the current `app_terms` version (`requireAppTermsAccepted`
  middleware) — `ha_data_sharing` never gates the tenant's own dashboard,
  only HA/LA drill-down.
- Bumping an agreement's `version` (new row, same `type`) makes every
  property's status for that type come back `null` again automatically —
  their old consent was for a different `agreement_id`, so they're
  re-prompted next visit without any extra "did the version change" code
  (spec §9a.4 point 3).

Frontend (`public/dashboard.js`): a blocking modal for `app_terms`, a
dismissable banner for `ha_data_sharing` shown only when status is `null` for
the current version, and a "Data sharing settings" card with a one-step
accept/withdraw toggle (spec §9a.4: "withdrawal must be at least as easy as
giving consent was").

The portfolio drill-down endpoint (`GET /portfolio/properties/:id`, added
alongside this) refuses rather than errors when consent isn't currently
`accepted` — `403 { error: 'not_shared' }` — matching §9a.3's "not a data
fault" framing. `public/portfolio.js`'s "View usage data" link calls this for
real now (step 8 shipped it as a dead link on purpose, pending this table).

**Placeholder legal text, not real.** `migrations/005_agreements.sql` seeds
both agreements with clearly-marked placeholder `document_text_or_url` —
spec §9 decision 6 says the real `ha_data_sharing` document/clause was
"clarified internally by UT" but that text isn't in the spec handed to this
build. Replace both rows' `document_text_or_url` with the real UT-legal-approved
text/URL before any real tenant sees this flow; insert a new row with the next
`version` rather than editing the existing one, so the version-bump
re-prompt behaviour applies correctly.

Verified end-to-end locally: dashboard 403s before `app_terms` acceptance,
`app_terms` correctly rejects a decline attempt, full accept→withdraw→re-accept
cycle preserved as 4 distinct rows in `consent_records`, a version bump
resets status to `null` and re-prompts, portfolio drill-down refused before
consent and returns real figures immediately after — all checked via curl and
via a real browser screenshot of the modal → banner → settings sequence a
first-time tenant actually sees.

## Admin subgroups by organization

`GET /admin/properties` now left-joins `organizations` and returns
`organization_name`; `public/admin.html` groups the properties table into a
section per organization (unassigned last), with a filter dropdown. A new
"Housing associations & local authorities" card lists orgs with property
counts, creates new ones, and invites their portfolio users
(`POST /admin/organizations/:id/users`) directly from the UI. "Add a property"
now takes an optional organization at creation time
(`POST /admin/properties { ..., organizationId }`), on top of the existing
`PATCH /admin/properties/:id/organization` for reassigning later.

This is purely an admin-side grouping convenience — the isolation itself
(each org only ever sees its own properties) was already enforced by
`organization_id` scoping in every `/portfolio/*` query, verified back in
step 8.

## Bill comparison graph ("with vs without Phase 1")

`src/dashboard/aggregate.ts`'s `getPropertyAggregate` now also returns a daily
`series: [{ date, without, with }]` — that day's grid-only bill vs actual bill
— for the same window it already aggregates. `GET /portfolio/summary` computes
an equivalent series summed across every property in the org (fixed a bug
while building this: grouping by a Postgres `date` value returned as a JS
`Date` object relies on object identity, not calendar-date equality, so two
properties' rows for the same date never merged until the code converted it
to an ISO date string first).

`public/chart.js` — a small dependency-free SVG line/area chart. Its two-colour
palette (brand yellow for "with Phase 1", a new teal for "without") was
validated with the dataviz skill's script against the app's dark result-card
surface: chroma floor, CVD separation, and contrast all pass; the lightness-
band check is a known, accepted exception since it assumes a near-black
surface and the brand's charcoal card isn't one — see the comment at the top
of `chart.js`. 2px lines, ~10% opacity area fill, end-dot markers with direct
end labels, hover crosshair + tooltip, and a legend (mandatory for 2 series).
Used in three places, all through the same component:

- Tenant's own dashboard (`public/dashboard.js`) — one chart per selected range.
- Portfolio aggregate (`public/portfolio.js`) — every property in the org, summed.
- Portfolio drill-down (same file) — one property's own chart, gated by the
  same `ha_data_sharing` consent check as the rest of drill-down.

Verified end-to-end locally with varied synthetic daily data (28 days, three
properties across two organizations): both chart placements render correctly
in a real browser, the portfolio aggregate correctly sums per-day across
properties (28 distinct days, not double-counted), and cross-org isolation
holds for the new series data exactly as it does for everything else in
`/portfolio/*`.

## Property health status, filters & sorting, time ranges

Deepened the HA/LA portfolio view and tenant dashboard beyond what step 8/the
comparison graph shipped:

**Property status** (`src/dashboard/propertyStatus.ts`) replaces the old
boolean `flagged` with a real status an HA/admin can act on:
`not_connected` (no Fox token yet) → `no_tenant` (linked but no tenant email
set) → `awaiting_data` (linked + tenant, no reading yet) → `disconnected` (no
reading in 48h, or no rollup in 2 days) → `ok`. `GET /portfolio/summary` now
returns `status` + `requiredActions` (a plain-English next step) per property;
`flagged` is still present (`status !== 'ok'`) for any older client reading it.
`public/portfolio.html`/`.js` render this as a coloured status pill — clicking
a non-OK pill opens a modal with the required action(s), so an HA user doesn't
have to guess what "disconnected" means or who should do what about it.

**Postcode + connection date** (`migrations/008_property_details.sql`) —
`postcode` is set at onboarding (`POST /admin/properties`); `connection_date`
is set once, automatically, the first time a property completes Fox OAuth
(`src/routes/oauth.ts`'s callback, `COALESCE`d so a later token refresh never
overwrites it). Both now appear in the portfolio property table, alongside a
status filter dropdown and click-to-sort column headers (ascending/descending,
toggled by clicking the same header again) — all client-side over the
properties array already returned by `/portfolio/summary`, no new endpoint.

**Time ranges — 24 hour / Week / Month / Year** replace the old
`day`/`week`/`4weeks`/`annual` options on both the tenant dashboard
(`GET /api/dashboard?range=...`) and the HA portfolio (`GET
/portfolio/summary?range=...`, `GET /portfolio/properties/:id?range=...`).
Week/Month/Year are the same trailing-window `daily_rollups` aggregation as
before (7/28/365 days), just renamed. 24 Hour is new and genuinely different:
`daily_rollups` only has daily granularity, so `src/dashboard/aggregate.ts`'s
new `getHourlyAggregate()` reads raw `meter_readings` instead — these are
cumulative-for-the-day snapshots (§4.2, reset to zero at midnight), so it
diffs consecutive readings to get each 15-minute increment, treating the first
reading of a new calendar day as its own increment rather than diffing it
against the previous day's last reading (which would double-count). Increments
are bucketed by hour and priced with that day's `tariff_rates`; standing
charge is deliberately left out of the hourly figures since attributing 1/24
of a fixed daily charge to an arbitrary hour would be misleading. The same
function takes an array of property IDs, so one implementation serves both a
single tenant's 24-hour view and the whole portfolio's, summed.

`public/chart.js` takes a new `granularity: 'hour'|'day'` option so the x-axis
and tooltip show a time (`14:00`) instead of a date for the 24-hour view.

Verified end-to-end locally: seeded five synthetic property states (one per
status value) and confirmed each computed correctly end-to-end through the
API and the rendered pill/modal; seeded 15-minute `meter_readings` spanning a
midnight boundary and confirmed the 24-hour view's hourly buckets carry no
discontinuity at the day rollover, on the tenant dashboard, the portfolio
aggregate, and the per-property drill-down; confirmed switching ranges while a
drill-down is open re-fetches it at the new range (not stale data left over
from the previous range).

## Interface updates (client feedback batch)

A round of specific interface feedback, implemented across all three
interfaces plus two new reference docs:

**Layout — graph above the summary, range picker inside the chart card.**
`public/dashboard.html` and `public/portfolio.html` (both the portfolio
aggregate and the per-property drill-down) now show the "bill with and
without Phase 1" chart *first*, with the 24 Hour/Week/Month/Year buttons
inside that same card, instead of a page-level range picker above a
bill-summary-first layout. No backend change — purely a reordering of
existing elements plus moving the already-existing `#rangeSelector` markup
into the chart card.

**Tenant: sharing toggle moved into Settings; consent folded into sign-in.**
`public/dashboard.html`'s main page no longer has a standalone "Data sharing
settings" card or an accept/decline banner — both are gone. A "Settings"
button in the header opens a modal with the sharing toggle. `ha_data_sharing`
consent is now recorded automatically the first time a property completes a
sign-in (`src/routes/auth.ts`'s `/auth/verify`, tagged
`recordedBy: 'implied_at_signin'`) rather than requiring a separate
accept/decline click — `public/index.html` and `public/signup.html` both
carry the "by signing in, you agree... you can opt out any time in Settings"
notice. This only ever *sets* consent when it's never been decided for the
current agreement version (`getCurrentConsentStatus(...).status === null`) —
an explicit decline/withdraw already on record, or a later change of mind in
Settings, is never silently overwritten by a subsequent login.

**Client interface: CSV export.** `GET /portfolio/export.csv?range=...`
(same range options as everywhere else) streams a property-by-property CSV
(address, postcode, tenant, connection date, status, solar/battery/grid kWh,
bill/saving figures) for the signed-in org — a "Download CSV" button sits
above the properties table in `public/portfolio.html`. Respects the same
consent gate as the drill-down endpoint: a property's usage columns are only
populated if that tenant currently has accepted `ha_data_sharing` consent;
otherwise the row still lists the property (address/postcode/tenant/status)
with blank usage figures, exactly like "Not shared" in the UI — this export
can't be used to see individual usage data consent was withheld for.

**Admin: CSV batch import with Fox-link surfacing and completion prompts.**
`public/admin.html` now has a CSV file input next to the existing single-
property form — parsed client-side (`parseCsv()` in `admin.js`, handles
quoted fields) into the same shape `POST /admin/properties/bulk` already
accepted, so no backend parsing was needed. Each created row's Fox consent
link and signup code are shown immediately so the connection process can
start right away; anything missing a postcode or tenant email gets a
click-to-fill-in "+ add" control (new `PATCH /admin/properties/:id`
endpoint) instead of a second trip through a spreadsheet. The same
completion control also appears in the regular properties table for any
property missing those fields, whichever way it was created.

**Mobile/tablet.** `public/chart.js`'s SVG chart now sizes its `viewBox` to
the container's actual measured width (capped at 720px) instead of a fixed
720-wide box scaled down by CSS — the old approach shrank axis labels and
legend text to the point of being unreadable on a phone-width card, since
scaling the whole 720-unit coordinate space down to ~300 real pixels scales
the "10.5px" text down to ~4px along with everything else. Sizing the
viewBox to match the real rendered width keeps text at its natural, legible
size at any screen width. `style.css` also softens the range-picker pill's
border-radius on screens ≤480px, since a 999px "fully round" radius looks
like a stretched stadium once the four buttons wrap to two rows. Checked at
390×844 (phone) and 768×1024 (tablet) viewports on both the tenant dashboard
and the portfolio view.

**New reference docs:**
- `docs/Fox_API_Integration_Guide.md` — granular walkthrough of the Fox
  OAuth linking flow, the polling job, token encryption/refresh, required
  environment variables, and what's still unverified against Fox's real
  sandbox.
- `docs/Release_And_Data_Retention.md` — how the migrate-then-deploy sequence
  keeps tenant accounts, sessions, Fox connections, and usage history intact
  across a version upgrade, and what to add (a real deploy pipeline) before
  this runs against production data.

Verified end-to-end locally: scoped Operations/Installer accounts confirmed
to see only their assigned clients (and an unassigned Installer confirmed to
see everything, per spec) via direct API checks; CSV batch import exercised
with a mixed valid/invalid file (partial success, per-row errors surfaced);
the `PATCH /admin/properties/:id` completion flow confirmed to actually
persist; CSV export checked against a shared and a not-shared property in
the same org, confirming the consent gate holds; the sign-in consent
auto-accept confirmed against `consent_records` directly; and all of the
above checked visually in a real browser, including at phone/tablet
viewport widths.

## Known gaps before real go-live

Everything in spec §10's build order (steps 1-9) is implemented and verified
against mocks/synthetic data. Before this touches a real tenant or real Fox
hardware, these need real input that wasn't available while building:

- **Fox OAuth field names/signing** (`src/fox/client.ts`,
  `src/fox/reportClient.ts`) — built from Fox's public docs, which don't give
  a fully explicit schema. Confirm against Fox's sandbox with UT's real
  `client_id`/`client_secret` (§9 decision 2) and adjust those two files if
  needed — nothing else should need to change.
- **Real email provider** (`src/lib/mailer.ts`) — currently logs the magic
  link instead of sending it.
- **Real legal text** for `app_terms` and `ha_data_sharing`
  (`migrations/005_agreements.sql`) — currently clearly-marked placeholders.
- **Real UT logo/icon assets** (`public/manifest.json`, header `logo-box`) —
  currently the calculator's own text/colour-mark fallback, not a fabricated
  logo.
- **No rate limiting on `/auth/signup` or the magic-link endpoints** — the
  signup code space resists casual guessing but there's no throttling behind
  it yet; add before real go-live.
- **Actual deployment** — `render.yaml` is a tested-locally blueprint; nobody
  has provisioned a real Render account/database against it yet.

## Database

Plain SQL migrations in `migrations/`, applied in filename order and tracked in a
`schema_migrations` table (`npm run migrate`, `src/db/migrate.ts`). No ORM — kept
deliberately simple for pilot scale (§2, §3).

`001_init.sql` creates the pilot-scope tables from spec §5: `properties`,
`meter_readings`, `daily_rollups`. The HA/LA portfolio tables (`organizations`,
`organization_users`, `agreements`, `consent_records` — spec §9a) are deferred to
build-order steps 8-9.

## Deploy

`render.yaml` is a Render Blueprint: one web service + one managed Postgres
database + three cron services (poller every 15 minutes, token refresher
every 30 minutes, nightly rollup at 02:00) running `src/jobs/poll.ts`,
`refresh-tokens.ts`, and `rollup.ts` respectively. All three were missing
from the blueprint until this was caught while writing
`docs/Fox_API_Integration_Guide.md` — the jobs existed in code since steps
2-4 but nothing was ever scheduling them, so no Fox usage data would
actually have been collected on a real deploy despite the app code being
otherwise correct.

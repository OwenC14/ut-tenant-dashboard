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
- `GET /api/dashboard?range=day|week|4weeks|annual` — requires the session
  cookie; returns only the authenticated tenant's own `daily_rollups` data
  (property-scoped at the query, never trusts a client-supplied property id).

No real email provider is wired up yet (`src/lib/mailer.ts` just logs the link) —
swap that one function for Postmark/SES/Resend/etc. before onboarding real
tenants.

The four range options (§7) are trailing windows — 1/7/28/365 days — ending at
the most recent date with a `daily_rollups` row, not literally "today", since
the nightly rollup only just computed yesterday by the time a tenant looks.
Defaults to `4weeks` on first load per spec (a single day's weather is a
misleading first impression). Per-day cost breakdown (solar saving / battery
off-peak cost / grid cost, in £) is recomputed from `tariff_rates` at query time
rather than stored, so it stays correct across a tariff change mid-range.

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

`/admin/*` — property onboarding, protected by a shared bearer token
(`ADMIN_API_KEY`, not a full admin user/role system — reasonable at pilot scale
with a small install team, revisit before scale-out per §2):

- `POST /admin/properties` — create one property; returns its id and a
  ready-to-share Fox consent link (`GET /oauth/fox/authorize?propertyId=...`).
- `POST /admin/properties/bulk { properties: [...] }` — create many in one call
  ("at scale", §10 step 7) without needing a CSV parser; one bad/duplicate row
  reports an error for that row without aborting the rest of the batch.
- `GET /admin/properties` — list every property with onboarding status (Fox
  linked? tenant email set? last reading/rollup?) so install staff can see
  what's still outstanding across the pilot's 100-200 properties.
- `public/admin.html` — a minimal UI over the same API (prompts once for the
  admin key, stores it in `localStorage`): a form to add a property and a
  table of onboarding status with each property's Fox consent link.

Per-property install/commissioning order (§4.1, §9 decision 1): (1) confirm or
create the tenant's Fox Cloud account — the OAuth consent flow depends on it
existing; (2) install the hardware and note the device serial number; (3) add
the property via `/admin/properties`; (4) send the tenant the Fox consent link
to link their device; (5) once you have the tenant's email, set
`tenant_email` (re-`POST /admin/properties` isn't wired for updates yet — a
direct `UPDATE properties` is the pilot-scale stopgap) so they can request a
dashboard magic link. Deliberately not gated on any consent/agreement step
yet — that's step 9, sequenced after onboarding on purpose (§10).

Verified end-to-end locally: unauthorized/wrong-key rejection, single create,
duplicate device-SN/email rejection (409), bulk import with a mix of
valid/invalid/duplicate rows, and the admin page exercised in a real browser
(prompt → form submit → table refresh with the new row).

## HA/LA portfolio view (spec §9a, §10 step 8)

`organizations` / `organization_users` / `properties.organization_id` (§9a.2).
Org users authenticate the same way tenants do — magic link via email — but
through a separate `/org-auth` + `org_sessions` pair, so an org session token
can never resolve to a `propertyId` or vice versa (isolation "one level up",
§9a.3).

- `GET /portfolio/summary` — requires an org session; aggregates *every*
  property assigned to that org's `organization_id` over the trailing 28 days
  (§9a.3: aggregate totals include all properties regardless of consent status,
  since a sum/average doesn't identify an individual tenant). Also returns a
  per-property list with a `flagged` indicator (no reading in 48h or no rollup
  in 2 days — a stale property, not a data fault) and `drilldownAvailable`.
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
- **Admin auth is a single shared bearer token**, not real UT staff accounts —
  fine at pilot scale (§2), revisit before scale-out.
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
database. Background worker/cron services for the token refresher, poller, and
nightly rollup job (spec §6) get added once those jobs exist (steps 2-4).

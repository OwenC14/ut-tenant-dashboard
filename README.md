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
- [ ] 7. Onboarding flow at scale
- [ ] 8. Organizations model + HA/LA portfolio view
- [ ] 9. Agreements/consent_records sign-up flow

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

# UT Tenant Savings Dashboard

Pulls generation/battery/grid data from each property's Fox ESS inverter (Fox Open
API) and shows tenants their solar/battery/grid usage split and bill savings.

Full spec: [`docs/UT_Tenant_Dashboard_Spec.md`](docs/UT_Tenant_Dashboard_Spec.md).

## Status

Build order (spec §10):

- [x] 1. Scaffold repo, Postgres schema, deploy skeleton
- [x] 2. Fox OAuth flow for one test device
- [ ] 3. Poller for one device
- [ ] 4. Nightly rollup job + cost calculation
- [ ] 5. Dashboard API + minimal frontend
- [ ] 6. Multi-tenant isolation (second/third property)
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

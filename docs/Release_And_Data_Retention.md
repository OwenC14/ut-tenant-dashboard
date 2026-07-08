# How new versions get rolled out without losing client data

This explains what happens to existing tenant accounts, housing association/local
authority logins, admin accounts, and Fox connections when a new version of the
app is deployed — the short answer is: nothing happens to them, by design, as
long as the practices below are followed. This describes how the app is built
today, not a future promise; the mechanics are already in place.

## Why a code deploy doesn't touch anyone's data

The app is split into two independent things:

- **The application code** (this repository) — stateless. It has no memory of
  who's logged in or what's been onboarded. Every request it handles starts by
  asking Postgres.
- **The Postgres database** — the only place any of that lives: tenant/org/
  admin accounts (`properties`, `organization_users`, `admin_users`), every
  active login (`sessions`, `org_sessions`, `admin_sessions`), Fox OAuth tokens
  (`properties.fox_access_token`/`fox_refresh_token`, encrypted — see
  `docs/Fox_API_Integration_Guide.md`), tenant signup codes, consent history,
  and all the usage data itself (`meter_readings`, `daily_rollups`).

Deploying a new version replaces the running Node process with a new one built
from the new code. It does **not** touch the Postgres database at all unless a
migration is explicitly run. So: existing logins stay logged in (session
tokens are validated against the `sessions`/`org_sessions`/`admin_sessions`
tables, not against anything in the code or process memory), Fox connections
keep working (tokens are read from `properties`, not recreated), and every
`daily_rollups`/`meter_readings` row is untouched.

## How schema changes ("migrations") work

Database changes live as numbered SQL files in `migrations/` (currently
`001_init.sql` through `009_admin_tiers_v2.sql`). Running `npm run migrate`
(`src/db/migrate.ts`):

1. Reads which migrations have already been applied, from a
   `schema_migrations` table it maintains itself.
2. Applies only the new ones it hasn't seen, in filename order, each inside
   its own transaction (so a half-applied migration can never happen — it's
   either fully applied or fully rolled back).

This means running `npm run migrate` again after a deploy is always safe and
a no-op if nothing changed. It's also why upgrading is a two-step, not
one-step, process: **run migrations, then deploy the new code that expects
them** — not the other way around, and not both at once. A few concrete
examples from this codebase's own history:

- `008_property_details.sql` added `postcode` and `connection_date` columns
  to `properties`. Existing rows just got `NULL` in the new columns — nothing
  about existing properties changed or was lost.
- `009_admin_tiers_v2.sql` renamed the `install_staff` role to `operations`
  with a data migration (`UPDATE admin_users SET role = 'operations' WHERE
  role = 'install_staff'`) in the same file as the schema change, so existing
  admin accounts kept working under their new role name rather than becoming
  invalid.

Every migration so far has been **additive** (new tables, new nullable
columns, renaming values rather than deleting them) — none has ever dropped
a column or table that held real data. That's a deliberate pattern worth
keeping: prefer "add the new thing, migrate the data across, remove the old
thing in a later release once nothing reads it anymore" over a single
destructive change, so there's never a moment where a still-running old
process and an already-migrated database disagree about what a column means.

## What this means for a real production rollout

None of the above requires special tooling to be true — but a few things
should be in place before this goes live for real (also listed in the
README's "Known gaps" section), to make the migrate-then-deploy sequence
automatic instead of a manual step someone has to remember:

- **Run `npm run migrate` as part of the deploy pipeline, before the new
  app code starts serving traffic** — not as a separate manual step. Most
  hosting platforms support a "release phase" or "pre-deploy" command for
  exactly this.
- **Take a database backup/snapshot before running migrations** on a
  production database, even though the migration pattern above is designed
  to be safe — this is standard practice, not a sign the app doesn't trust
  its own migrations.
- **Zero client-visible downtime**: because sessions/tokens live in Postgres
  rather than in server memory, running multiple app server instances behind
  a load balancer during a rolling deploy is safe — a tenant's request can
  land on an old-code instance or a new-code instance interchangeably mid-
  rollout without being logged out, as long as the database has already been
  migrated to a schema both versions understand (which is exactly what the
  additive-migration pattern above guarantees).
- **No CI/CD pipeline or staging environment exists yet** — right now,
  running `npm run build`, `npm run migrate`, and starting the server are
  manual steps. Before real client data is at stake, wire these into an
  actual pipeline (build → migrate staging → smoke test → migrate production
  → deploy) rather than running them by hand against production.

## What survives a version upgrade, explicitly

- Tenant accounts, emails, and login sessions.
- Housing association/local authority (org) accounts, roles, and sessions.
- Admin accounts, roles, and client assignments.
- Fox OAuth connections (access/refresh tokens, encrypted) and all historical
  usage data.
- Tenant/HA/LA consent history (`consent_records` is append-only — it's
  never rewritten, only added to, by design; see the consent flow section
  of the README).
- Unclaimed signup codes and unsent invites.

## What a version upgrade can change (and how that's handled safely)

- **What a role can do** — e.g. the `install_staff` → `operations` rename
  above changed permissions, not identity; the account and its login kept
  working throughout.
- **New required fields** — always added as nullable first (see `postcode`),
  never as `NOT NULL` on a table that already has rows, unless a backfill
  step runs in the same migration to populate the new column for existing
  rows before any constraint is added.
- **Consent/terms text changes** — versioned explicitly (`agreements.version`)
  rather than edited in place, so a client's past acceptance of an old
  version is preserved as a historical record, and they're re-prompted for
  the new version rather than silently deemed to have agreed to text they
  never saw (see the "Consent flow" section of the README).

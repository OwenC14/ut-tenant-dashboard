# UT Tenant Savings Dashboard — Technical Spec
**For: Union Technical EaaS Phase 1 (Battery & Solar)**
**Purpose: hand-off document for building with Claude Code**
**Status: draft — starting from zero infrastructure**

---

## 1. What this is

A service that pulls real generation/battery/grid data from each property's Fox ESS
inverter via the Fox Open API, and shows each tenant a dashboard of their actual
solar-used / battery-used / grid-used split and bill savings — the same categories
and visual language as the `UT_Phase1_Tenant_Calculator.html` estimator, but backed
by real metered data instead of assumptions.

**This is not** a live real-time feed. Fox's API rate limits (see §4) mean this is a
polling system on a schedule (e.g. every 15–30 minutes), which is more than
sufficient for a tenant-facing daily/weekly savings view.

---

## 2. Scope decision: pilot first, not portfolio-scale

UT's eventual EaaS target is ~20,000 properties. **Do not build for that scale on day
one.** Starting from zero infrastructure, the right move is:

- **Phase A (pilot):** 100–200 properties (confirmed, §9.3). A single backend
  service, single database,
  simple cron-based polling. This is buildable in days, not weeks.
- **Phase B (scale-out):** once the pilot is proven, the polling layer becomes a
  proper job queue (e.g. per-device jobs distributed across workers) so 20,000
  devices × 1 poll/15min doesn't bottleneck on a single process. This is a
  rearchitecture, not a rewrite — the data model below is designed to support it,
  but the polling mechanism will need to change.

Flagging this now so nobody assumes the pilot codebase directly scales to the full
programme without revisiting the polling architecture.

---

## 3. Recommended stack (chosen for "zero existing infrastructure")

The priority is low operational overhead over performance headroom, since there's no
dev team maintaining this yet.

| Layer | Recommendation | Why |
|---|---|---|
| Backend | Node.js + TypeScript (Express or Fastify) | Claude Code is strong here; huge ecosystem for OAuth/HTTP |
| Database | Postgres (managed, e.g. via the hosting provider) | Relational fits this data well; every host offers a managed option |
| Hosting | Render, Fly.io, or Railway | Git-push deploys, managed Postgres add-on, background workers/cron built in, no server management |
| Scheduler | Host's built-in cron / background worker (not a separate infra piece) | Avoids standing up Kubernetes or similar for a pilot |
| Frontend | Reuse the existing calculator's HTML/CSS/JS pattern, or a small React app | Keeps visual consistency with what tenants have already seen |
| Secrets | Host's environment variable / secrets manager | Fox client_id/secret and per-tenant tokens must never sit in the repo |

None of this requires a dedicated ops person to run at pilot scale.

---

## 4. Fox Open API integration

**Docs:** https://www.foxesscloud.com/public/i18n/en/OpenApiDocument.html

### 4.1 Authentication
Fox supports two modes — **use OAuth2, not the private API-key mode**, because this
is multi-tenant (many separate properties/inverters, each owned by a different
tenant/household, not one account you control):

1. Register a client in Fox's developer portal → get `client_id` + `client_secret`.
2. Redirect each tenant to Fox's consent page:
   `https://{domain}/h5/auth/foxessIndex?response_type=code&client_id={id}&redirect_uri={uri}&scope={scope}`
3. Tenant logs into their own Fox account and grants consent for their device.
4. Fox redirects back with an authorization code → exchange for an access token +
   refresh token, store both against that tenant's property record.
5. Refresh the token before expiry (implement this as a scheduled job, not on-demand,
   so a stale token doesn't silently break polling).

**This means:** each tenant needs their own Fox Cloud login before the OAuth flow
can run. Confirmed (§9.1): this becomes a required step in the install/commissioning
checklist, alongside the in-app consent flow (§9a.4) — both need to happen before a
property can be onboarded to the dashboard.

### 4.2 Data to pull
Per device, request the report variables:
- `generation` — solar output
- `loads` — total household demand
- `feedin` — exported to grid
- `gridConsumption` — imported from grid
- `chargeEnergyToTal` — battery charge
- `dischargeEnergyToTal` — battery discharge

From these, derive the three categories the calculator already uses:
- **Solar self-consumed** = `generation` − `feedin` (solar used on-site, not exported)
- **Battery-covered demand** = `dischargeEnergyToTal` (what the battery supplied)
- **Grid-covered demand** = `gridConsumption`

Sanity check on ingest: `loads` should roughly equal solar self-consumed + battery
discharge + grid consumption. Log and flag properties where this doesn't reconcile
(meter/CT clamp misconfiguration is common and shows up exactly this way).

### 4.3 Rate limits — design constraint
- 1,440 calls/device/day, queries capped at 1/second, each endpoint counted
  separately.
- At a 15-minute poll interval that's 96 calls/device/day per endpoint — comfortably
  within budget even pulling several report variables per poll.
- At pilot scale (≤200 devices) a single sequential or lightly-parallel poller
  respects the 1/sec cap easily. At 20,000 devices this requires proper request
  queuing/throttling — see §2.

---

## 5. Data model (pilot scope)

```
properties
  id (pk)
  address
  tenant_name
  ha_or_la_partner        -- nullable, for co-branding
  fox_device_sn
  fox_access_token         (encrypted)
  fox_refresh_token        (encrypted)
  fox_token_expires_at
  install_date
  array_size_kwp
  battery_capacity_kwh
  created_at

meter_readings
  id (pk)
  property_id (fk)
  reading_time
  generation_kwh
  feedin_kwh
  grid_import_kwh
  battery_charge_kwh
  battery_discharge_kwh
  loads_kwh
  raw_response              -- store the raw Fox payload for debugging/reprocessing

daily_rollups
  id (pk)
  property_id (fk)
  date
  solar_self_consumed_kwh
  battery_covered_kwh
  grid_covered_kwh
  estimated_cost_current_bill   -- what they'd have paid at grid rate for everything
  estimated_cost_new_bill       -- actual cost given the real solar/battery/grid split
  estimated_saving
```

Rollups are computed nightly from raw readings, using the same tariff-rate logic as
the calculator (grid price cap rate, off-peak rate, standing charge — these should be
configurable, not hardcoded, since Ofgem's cap changes quarterly).

---

## 6. Backend components

1. **OAuth flow handler** — consent redirect, callback, token exchange, token storage.
2. **Token refresher** — scheduled job, refreshes tokens nearing expiry.
3. **Poller** — scheduled job (e.g. every 15 min), calls Fox API per property, writes
   to `meter_readings`.
4. **Rollup job** — nightly, aggregates readings into `daily_rollups` with cost
   calculations.
5. **Dashboard API** — serves a tenant's own rollup data to the frontend. Must
   authenticate the tenant and only return their own property's data — no
   cross-tenant data exposure.
6. **Admin/reconciliation view** (optional, useful early) — a simple internal page
   showing which properties are polling successfully vs erroring, so problems don't
   go unnoticed silently.

---

## 7. Frontend

Reuse the visual system already built in `UT_Phase1_Tenant_Calculator.html`:
Union Technical brand colours, the bill-compare cards, the solar/battery/grid bar and
legend. The dashboard becomes a "real data" sibling to the "estimate" calculator —
worth linking the two ("this is what we estimated → here's what actually happened")
once both exist.

**Time-range selector (confirmed requirement):** a period control with four
options — **that day**, **that week**, **last 4 weeks**, **annual**. Each option
re-queries `daily_rollups` over the corresponding window and re-renders the same
bill-compare/bar/breakdown components already built for the calculator, just fed
real data instead of slider-derived estimates. Default to a sensible view for a
first-time tenant (last 4 weeks is probably more meaningful than "that day" on
first login, since a single day's weather can be misleading).

Built as a PWA (§9b) — same codebase serves the direct-link and add-to-home-screen
use cases without a separate build.

---

## 8. Security & data handling

- Energy usage data is personal data (tied to an identifiable household) — handle
  it under UK GDPR: define a lawful basis, a retention period, and who at UT can
  access raw per-property data vs aggregate figures only.
- Fox tokens are credentials to someone's home energy hardware — encrypt at rest,
  never log them, rotate the app's own `client_secret` if it's ever exposed.
- Tenant-facing dashboard auth should be separate from the Fox OAuth token — a
  tenant logging into *their UT dashboard* is a different credential from *their Fox
  account*. Don't conflate the two.

---

## 9a. Housing Association / Local Authority portfolio view

HAs and LAs need a different product from the tenant dashboard: portfolio-level
oversight across many properties, not one household's own data.

### 9a.1 Access level: per-property drill-down (confirmed)

UT has confirmed HA/LA per-property drill-down access is intended, agreed at the
point the EaaS hardware is signed over for a property.

**One distinction worth keeping precise in the build:** the MPAN registration itself
is a metering/supply administration event (DNO/supplier settlement, connection
responsibility) — it isn't a data-protection consent instrument. The lawful basis for
an HA seeing a named tenant's granular usage data needs to come from an actual signed
document the tenant has agreed to (e.g. an EaaS participation agreement or tenancy
addendum containing an explicit data-sharing clause), not from the MPAN paperwork
itself. Before building the drill-down feature, confirm with whoever handles UT's
contract review (the same process used for the Fortriu MOU) exactly which document
and clause this consent lives in — this becomes the `agreements` record described in
§9a.4, and that's what you'd point to if a tenant or regulator ever asked what the
lawful basis was; "the MPAN was registered" would not be a sufficient answer on its
own.

### 9a.2 Data model additions
```
organizations
  id (pk)
  name                      -- e.g. a specific Housing Association or Local Authority
  type                      -- 'HA' | 'LA' | 'other'
  logo_url                  -- for co-branding on tenant-facing pages
  created_at

-- properties gets a new column:
properties.organization_id (fk, nullable)      -- nullable: not every property is HA/LA-owned

organization_users
  id (pk)
  organization_id (fk)
  name
  email
  role                      -- e.g. 'portfolio_viewer', 'portfolio_admin', 'drilldown_viewer'
```

### 9a.3 Portfolio & drill-down API
- Aggregate portfolio queries (totals, averages, flagged properties) as before —
  these include every property regardless of `ha_data_sharing` status, since no
  individual tenant is identified at aggregate level.
- **Per-property drill-down must check the property's current `ha_data_sharing`
  status is `'accepted'` before returning that property's data to an HA user.** For
  `'declined'`, `'withdrawn'`, or no record at all, the API must refuse drill-down —
  not error, just decline to return the row.
- The HA-facing portfolio UI should show declined/withdrawn properties in aggregate
  counts as normal, but render drill-down as clearly unavailable ("this tenant has
  not shared individual-level data") rather than a blank row or a broken link —
  an HA seeing a property silently missing from a list looks like a data fault, not
  a tenant's deliberate choice, so the distinction needs to be visible.
- Access control: `organization_users` scoped to their own `organization_id`, same
  isolation principle as tenant access, one level up.

### 9a.4 In-app agreement & sign-up flow

Rather than relying on an external, possibly-ambiguous paper process as the lawful
basis, the app itself should capture consent directly — versioned, timestamped, and
tied to a specific user action. This becomes the actual source of truth for HA
drill-down eligibility, not a placeholder pointing at offline paperwork.

**Refusal is a real, supported outcome, not an edge case.** A tenant can decline
`ha_data_sharing` and keep full use of their own savings dashboard — the two are
kept as separable acceptances precisely so declining one doesn't block the other.
Declining must be recorded explicitly (not just "no row exists"), so there's a clear
audit trail that the tenant was asked and said no, distinct from "never asked yet."
Tenants can also change their answer later — accept after having declined, or
withdraw after having accepted — via a settings screen in their own dashboard.
Withdrawal must be at least as easy as giving consent was (a one-step toggle, not a
support ticket).

```
agreements
  id (pk)
  type                      -- 'app_terms' | 'ha_data_sharing'
  version
  document_text_or_url
  effective_from
  created_at

consent_records
  id (pk)
  property_id (fk)
  agreement_id (fk)
  status                    -- 'accepted' | 'declined' | 'withdrawn'
  recorded_at
  recorded_by               -- name/identifier of who acted, if not the property owner directly
  ip_address
  user_agent
```

`consent_records` is append-only — every change of mind is a new row, never an
overwrite, so the full history (asked → declined → later accepted → later withdrawn)
stays intact for audit purposes. The tenant's *current* status for an agreement type
is always "the most recent row for that `property_id` + `agreement_id`," never
inferred from row existence alone.

Flow:
1. On first app access for a property, present the current `app_terms` agreement.
   Require explicit acceptance before the dashboard is usable.
2. Present the `ha_data_sharing` agreement as a distinct step — accept or decline,
   both recorded — not folded silently into app_terms acceptance, and not a forced
   "accept to continue" gate.
3. If an agreement's version changes (document updated), existing users are
   re-prompted before continuing to use the affected feature (app generally, or HA
   drill-down specifically) — a prior "accepted" on an old version doesn't carry
   forward automatically to a materially changed document.
4. Tenant dashboard includes a settings view showing current status for
   `ha_data_sharing` and a control to change it at any time — this writes a new
   `consent_records` row, it doesn't edit the old one.
5. A property's current `ha_data_sharing` status is always "the most recent
   `consent_records` row for that property and the current agreement version" — the
   §9a.3 drill-down check queries this live, rather than trusting a static flag
   that could go stale.

---

## 9. Decisions (resolved)

1. **Fox Cloud tenant account creation** — confirmed as a required step in the
   install/commissioning process. The install checklist must include creating (or
   confirming) each tenant's Fox Cloud account, since the OAuth consent flow in §4.1
   depends on it existing.
2. **Fox Open API client registration** — UT registers a single Fox Open API client
   (`client_id`/`client_secret`) centrally. Per-tenant authorisation happens via
   OAuth consent at each individual install (see note above on this reading —
   confirm if a different structure was intended).
3. **Pilot size** — 100–200 properties. This confirms Phase A scope (§2) and the
   Render/Fly/Railway-tier hosting recommendation in §3 comfortably covers this
   without needing paid infrastructure tiers from day one.
4. **Access method** — see §9b below (new section, since this needs more than one
   line to get right).
5. **Dashboard time-range views** — confirmed: a period selector with four options —
   **that day**, **that week**, **last 4 weeks**, **annual**. Added to §7 frontend
   requirements below.
6. **HA data-sharing consent document/clause** — clarified internally by UT. Not
   detailed further in this spec; the `agreements` record in §9a.4 should reference
   whatever was confirmed.

---

## 9b. Access method: PWA over native app store distribution

Given the mix of tenants (some wanting a simple link, some wanting an app-like icon),
**a Progressive Web App (PWA) is the recommended approach** rather than a native App
Store / Play Store listing:

- Same HTML/CSS/JS already being built for the dashboard, plus a web manifest and
  service worker.
- Tenants who just want a link can use the link directly — no change needed.
- Tenants who want an "app" can add it to their home screen from the browser (Safari
  on iOS, Chrome on Android) and get an icon and app-like full-screen experience,
  with no app store account, review process, or fee involved.
- Works identically for HA/LA co-branded versions — no separate app store listing
  needed per partner.

**Not recommended for the pilot:** wrapping this in a native shell for true App
Store / Play Store distribution. That requires an Apple Developer Program account
(recurring fee), a Google Play developer account, native wrapping (e.g. Capacitor),
and app review on both platforms — a real ongoing commitment, not a one-off task.
Revisit only if a specific need emerges that a home-screen PWA can't satisfy (e.g.
full push notification support, which iOS PWAs only partially provide).

**This doesn't foreclose native app store distribution later.** Wrapping the same
web codebase with Capacitor (or similar) to produce an actual iOS/Android app is
additive work on top of the PWA, not a rewrite — provided the build keeps the
frontend cleanly separated from the backend API (already the case per §6) and avoids
relying on browser-only behaviour with no native equivalent. Confirm this
expectation with Claude Code explicitly when building the frontend, so "we might
wrap this later" is a design constraint from the start rather than a retrofit.

---

## 10. Suggested Claude Code build order

1. Scaffold the repo (Node/TypeScript, Postgres schema from §5, deploy skeleton to
   the chosen host).
2. Build the Fox OAuth flow end-to-end for one test device.
3. Build the poller for one device, verify data reconciles (§4.2 sanity check).
4. Build the nightly rollup job and cost calculation, reusing the calculator's
   tariff-rate logic.
5. Build the dashboard API + a minimal frontend showing one property's data.
6. Add the second, third... property to prove multi-tenancy actually isolates data
   correctly.
7. Only then: onboarding flow for adding new properties/tenants at scale.
8. Once the tenant dashboard is proven: add the `organizations` model and the
   aggregate portfolio view for HAs/LAs (§9a) — deliberately sequenced after
   individual dashboards work, since portfolio rollups depend on the same
   `daily_rollups` data already being correct.
9. Build the `agreements`/`consent_records` sign-up flow (§9a.4) — including
   explicit decline and later withdrawal handling — before enabling drill-down for
   any real property. This is what makes drill-down eligibility meaningful rather
   than assumed, so it belongs early, not as a late add-on.

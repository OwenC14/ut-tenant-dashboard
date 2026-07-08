# Fox Open API Integration Guide

This is a granular, code-accurate walkthrough of how the UT Tenant Savings
Dashboard links to and pulls data from Fox ESS inverters via the Fox Open API.
It's written for an engineer who needs to understand, maintain, or explain the
integration — not for someone building it from scratch, and it assumes no
familiarity with this repo's tooling.

Everything below is drawn directly from the source files listed at the end of
each section. Where the code itself is uncertain about something (mostly:
exact Fox response shapes that were built from public docs rather than a live
sandbox), that uncertainty is called out explicitly rather than smoothed over
— see [§8 Known gaps](#8-known-gaps--what-needs-confirming-with-foxs-real-sandbox-before-go-live).

---

## 1. Overview: how the pieces fit together

There are three things that need to line up for one property to work:

```
properties (Postgres row)  ←→  a physical Fox inverter/device  ←→  a Fox Cloud OAuth grant
```

- **`properties`** is the one row per household/property (migration
  `001_init.sql`). It holds the tenant's details, the Fox device's serial
  number (`fox_device_sn`), and — once OAuth has run — the encrypted OAuth
  tokens (`fox_access_token`, `fox_refresh_token`, `fox_token_expires_at`).
- **The Fox device** is identified purely by its serial number (`sn`), which
  install staff read off the hardware and type into the property record.
  There's no other pairing mechanism — if the wrong serial number is entered,
  the report queries will simply address someone else's device (or fail if
  the SN doesn't exist under that tenant's Fox account).
- **The OAuth grant** is a per-tenant authorization on Fox's own cloud
  platform (foxesscloud.com), not something UT controls centrally beyond the
  one shared `client_id`/`client_secret`. Each tenant must have their own Fox
  Cloud login and must personally consent before the dashboard can read their
  device's data.

Concretely, the modules involved are:

| File | Responsibility |
|---|---|
| `src/fox/client.ts` | Builds the Fox consent URL; exchanges an auth code for tokens; refreshes tokens |
| `src/fox/reportClient.ts` | Calls Fox's device report endpoint and totals the day's numbers |
| `src/routes/oauth.ts` | The two HTTP endpoints tenants/admins actually hit: `/oauth/fox/authorize` and `/oauth/fox/callback` |
| `src/oauth/stateStore.ts` | In-memory CSRF `state` tracking for the OAuth redirect |
| `src/lib/crypto.ts` | AES-256-GCM encryption of tokens before they touch the database |
| `src/jobs/poll.ts` | Runs on a schedule; pulls each property's usage data from Fox and writes a `meter_readings` row |
| `src/jobs/refresh-tokens.ts` | Runs on a schedule; refreshes any token expiring soon |
| `src/jobs/rollup.ts` | Nightly job that turns the day's `meter_readings` into cost/saving figures — not part of the Fox link itself, but consumes what the poller wrote (see §3) |

Nothing in this integration is a live/real-time feed. It is entirely
poll-based: a scheduled job calls Fox's API roughly every 15 minutes per
property and stores a snapshot. There is no webhook or push notification from
Fox in this codebase.

---

## 2. Linking a new property to Fox (the consent/OAuth flow)

This is the sequence from an admin creating a property record through to that
property having a working Fox connection.

### Step 0 — prerequisites

Per the spec (§4.1, §9.1) and the README's onboarding order, before the OAuth
flow can run for a property:

1. The tenant must already have their own Fox Cloud account (the consent flow
   depends on it existing — UT/install staff confirm or create this).
2. The inverter/battery hardware must be installed and its device **serial
   number** noted.

### Step 1 — admin creates the property record

`POST /admin/properties` (`src/routes/admin.ts`) creates the row. The request
requires `address`, `tenantName`, and `foxDeviceSn` (the device serial number
from step 0); `tenantEmail` is optional at this point (it can be set later by
the tenant via self-signup). On success the response includes:

```json
{
  "id": 42,
  "signupCode": "UT-7F3K9",
  "foxAuthorizeUrl": "http://localhost:3000/oauth/fox/authorize?propertyId=42"
}
```

`foxAuthorizeUrl` is built as `new URL('/oauth/fox/authorize?propertyId=' + id, APP_BASE_URL)` — this is the link install staff/admins send the tenant to actually link their Fox account. At this point `fox_device_sn` is stored but `fox_access_token`/`fox_refresh_token`/`fox_token_expires_at` are all `NULL` — the property exists but isn't linked yet.

### Step 2 — tenant (or install staff on their behalf) opens the consent link

`GET /oauth/fox/authorize?propertyId={id}` (`src/routes/oauth.ts`):

1. Validates `propertyId` is an integer and that a `properties` row with that
   id exists (404 `{ error: 'property not found' }` if not).
2. Calls `createState(propertyId)` (`src/oauth/stateStore.ts`), which
   generates a random 48-hex-character token (`randomBytes(24).toString('hex')`),
   stores `{ propertyId, expiresAt: now + 10 minutes }` in an **in-memory**
   `Map`, and returns the token as `state`.
3. Redirects (HTTP redirect, not JSON) to the URL built by
   `buildAuthorizeUrl(state)` in `src/fox/client.ts`:

   ```
   {FOX_DOMAIN}/h5/auth/foxessIndex
     ?response_type=code
     &client_id={FOX_CLIENT_ID}
     &redirect_uri={FOX_REDIRECT_URI}
     &scope={FOX_SCOPE}      (only included if FOX_SCOPE is set)
     &state={state}
   ```

   With the default `.env.example` values this resolves to something like
   `https://www.foxesscloud.com/h5/auth/foxessIndex?response_type=code&client_id=...&redirect_uri=http://localhost:3000/oauth/fox/callback&state=...`.

Because `state` is a one-time, 10-minute-lived, server-generated value tied to
exactly one `propertyId`, it serves as CSRF protection for the redirect: the
callback can't be satisfied with a forged or reused `state`, and a `state`
value on its own reveals nothing usable (the mapping to `propertyId` only
exists server-side, in memory).

**Note on the state store**: `states` is a plain in-memory `Map`, not
persisted to Postgres or Redis. The code comments explain this is an accepted
tradeoff at pilot scale (single Render instance) — a server restart during
the ~10-minute consent window just means the tenant has to click the link
again, not a data-integrity problem. This would need to move to a shared
store (Postgres/Redis) if the app ever runs multiple instances behind a load
balancer.

### Step 3 — tenant authenticates with Fox and grants consent

This step happens entirely on Fox's own site (`foxesscloud.com`'s
`/h5/auth/foxessIndex` page) — the tenant logs into their personal Fox Cloud
account and approves access for their device. This codebase has no visibility
into or control over that page; it only constructs the URL that gets them
there and receives Fox's redirect back afterward.

### Step 4 — Fox redirects back to the callback

`GET /oauth/fox/callback` (`src/routes/oauth.ts`) is what `FOX_REDIRECT_URI`
must point at. Fox appends `code` and `state` as query parameters on success,
or an `error` parameter if the tenant declined or something failed on Fox's
side. The handler:

1. If `error` is present: responds `400 { error: 'Fox consent declined or failed: {error}' }` and stops.
2. If `code` or `state` is missing: `400 { error: 'code and state query params are required' }`.
3. Calls `consumeState(state)` — looks up and **deletes** the entry from the
   in-memory map (so a `state` can only ever be used once), and returns
   `null` if it was never issued or has expired. If `null`: `400 { error: 'invalid or expired state' }`.
4. Calls `exchangeCodeForTokens(code)` (`src/fox/client.ts`) — see next
   section for exactly what this sends to Fox.
5. On success, writes the result to the `properties` row identified by the
   `propertyId` recovered from `state`:

   ```sql
   UPDATE properties
   SET fox_access_token = $1,      -- encrypted
       fox_refresh_token = $2,     -- encrypted
       fox_token_expires_at = $3,
       connection_date = COALESCE(connection_date, CURRENT_DATE)
   WHERE id = $4
   ```

   `connection_date` is set only the first time (via `COALESCE`) — a later
   token refresh (a separate code path, `src/jobs/refresh-tokens.ts`) never
   touches this column, so it always reflects when the property was first
   linked, not when its token last rotated.
6. Responds `200 { status: 'ok', message: 'Fox account linked', propertyId }`.

At this point the property has a working Fox connection and will be picked
up by the next run of the poller (§3).

### The token exchange call itself

`exchangeCodeForTokens(code)` in `src/fox/client.ts` POSTs form-encoded data
to `{FOX_DOMAIN}/oauth2/token`:

```
grant_type=authorization_code
code={code}
client_id={FOX_CLIENT_ID}
client_secret={FOX_CLIENT_SECRET}
redirect_uri={FOX_REDIRECT_URI}
```

It expects a JSON response containing (at minimum) `access_token`,
`refresh_token`, and `expires_in` (seconds; defaults to `3600` if Fox omits
it — the code does `Number(data.expires_in ?? 3600)`). These map to:

```ts
{
  accessToken: string,
  refreshToken: string,
  expiresAt: new Date(Date.now() + expiresIn * 1000),
}
```

If `access_token` or `refresh_token` isn't a string, or Fox's response isn't
valid JSON, or the HTTP call isn't a 2xx, the function throws — which the
route handler doesn't currently catch specially, so it propagates up as a 500
via the app's generic error handling (`asyncHandler`). There's no retry logic
around this call.

**Relevant files for this section:** `src/routes/admin.ts`, `src/routes/oauth.ts`, `src/oauth/stateStore.ts`, `src/fox/client.ts`, `migrations/001_init.sql`.

---

## 3. Ongoing data collection: the polling job

Once a property is linked, `src/jobs/poll.ts` is what actually pulls usage
data. It's run as a standalone script (`npm run poll`), not a
process the web server keeps alive — it's meant to be invoked by a scheduler
(cron / Render background worker) on a fixed interval.

**How often:** the spec (§4.3) and README describe a 15-minute cadence as the
intended interval, which is what the rate-limit math is based on (see below).
The polling *script itself* doesn't set up its own timer — it runs once and
exits (`pool.end()` at the bottom, then the process ends). Something external
has to invoke `npm run poll` every ~15 minutes.

Important caveat found while reading the deploy config: **`render.yaml` in
this repo only defines the web service and the database** — there is no
`type: worker` or `type: cron` service wired up for the poller, the
token-refresher, or the rollup job. The README notes these get added "once
those jobs exist," and the jobs now exist, but the actual cron/worker
registration in `render.yaml` has not been added yet. In other words: right
now, nothing will automatically run `npm run poll` on a real Render
deployment until that's configured.

### What one poll run does

For each row where both `fox_access_token` and `fox_device_sn` are non-null:

1. Decrypts the access token (`decrypt()`, see §4).
2. Calls `queryDeviceReport(accessToken, fox_device_sn, new Date())`
   (`src/fox/reportClient.ts`).
3. Runs a reconciliation check (see below), logging a warning if it fails —
   this never aborts the poll or blocks the write.
4. Inserts one row into `meter_readings`.
5. Sleeps ~1.1 seconds, then moves to the next property (sequential, not
   parallel).

### The Fox report call itself

`queryDeviceReport()` POSTs JSON to `{FOX_DOMAIN}/op/v0/device/report/query`:

```json
{
  "sn": "{fox_device_sn}",
  "year": 2026,
  "month": 7,
  "day": 8,
  "dimension": "day",
  "variables": ["generation", "loads", "feedin", "gridConsumption", "chargeEnergyToTal", "dischargeEnergyToTal"]
}
```

with headers:

```
Content-Type: application/json
Authorization: Bearer {accessToken}
signature: {md5 hex of "{path}\r\n{accessToken}\r\n{timestamp}"}
timestamp: {epoch ms as string}
lang: en
```

The `signature` header is Fox's request-signing scheme adapted for
OAuth-mode requests: rather than signing with a private API key (Fox's
non-OAuth mode), the code substitutes the access token into the same MD5
signing formula and still sends it alongside the `Authorization: Bearer`
header. This is called out in the code as inferred from spec/docs, not
verified against a real Fox request.

The expected response shape is:

```json
{
  "errno": 0,
  "result": [
    {
      "deviceSN": "...",
      "datas": [
        { "variable": "generation", "unit": "kWh", "data": [{ "time": "...", "value": 1.2 }, ...] },
        ...
      ]
    }
  ]
}
```

A non-2xx HTTP status or a non-zero `errno` throws. Otherwise, for each of
the six requested variables, `queryDeviceReport` **sums every hourly
datapoint's `value`** to produce one running total for the day
(`points.reduce((sum, p) => sum + (p.value ?? 0), 0)`). This assumes each
hourly point is an *increment* for that hour, not a cumulative running total
— explicitly flagged in the code comments as unconfirmed against a real
device (see §8).

### What gets stored

One row per poll per property in `meter_readings`:

| Column | Source |
|---|---|
| `reading_time` | `now()` (DB server time at insert) |
| `generation_kwh` | Fox `generation` total |
| `feedin_kwh` | Fox `feedin` total |
| `grid_import_kwh` | Fox `gridConsumption` total |
| `battery_charge_kwh` | Fox `chargeEnergyToTal` total |
| `battery_discharge_kwh` | Fox `dischargeEnergyToTal` total |
| `loads_kwh` | Fox `loads` total |
| `raw_response` | the full totals object as JSON (`JSONB`), kept for debugging/reprocessing |

Because Fox's `day` dimension is requested every poll (not just once daily),
each `meter_readings` row is effectively "today's cumulative total so far at
the moment of this poll," not a discrete 15-minute delta. This is important
context for how downstream consumers (rollup, the 24-hour dashboard view)
treat these rows as cumulative-for-the-day snapshots, diffing consecutive
rows where an hourly breakdown is needed, rather than treating each row as
its own independent increment. (This diffing logic lives in
`src/dashboard/aggregate.ts`'s `getHourlyAggregate()`, outside the scope of
this guide, but it's worth knowing the shape of the data it's built on.)

### The reconciliation check

Before writing the row, `poll.ts` checks:

```
solarSelfConsumed = generation - feedin
reconciledLoads   = solarSelfConsumed + dischargeEnergyToTal + gridConsumption
diff              = |reconciledLoads - loads|
```

If `diff > 0.5` kWh, it logs (`console.warn`) but does **not** fail the poll
or skip the write — the reading is stored either way. The comment in the code
notes a mismatch beyond tolerance is usually a meter/CT clamp
misconfiguration on the physical installation, not a real usage pattern, so
it's treated as something to flag for a human rather than a hard error.

### Rate limiting

Fox's documented cap (spec §4.3) is 1,440 calls/device/day, 1 request/second,
per endpoint. The poller respects the 1/sec ceiling with a hardcoded
1.1-second `setTimeout` between properties, processed strictly sequentially
in a `for` loop — not in parallel. At pilot scale (≤200 devices) this is
fine; the code comments flag that this sequential-with-sleep approach won't
scale to a real 20,000-device rollout and would need to become a proper job
queue at that point.

### Nightly rollup (brief — not the focus of this guide)

`src/jobs/rollup.ts` (`npm run rollup [YYYY-MM-DD]`) runs once nightly,
takes each property's *last* `meter_readings` row for the target day (a
`DISTINCT ON (property_id) ... ORDER BY reading_time DESC` query — i.e. the
final, most-complete cumulative snapshot before the day rolled over), and
turns it into one `daily_rollups` row with cost/saving figures computed
against `tariff_rates`. It doesn't call Fox directly — it only consumes what
`poll.ts` already wrote to `meter_readings`. See the README's "Nightly
rollup" section for the cost formulas.

**Relevant files:** `src/jobs/poll.ts`, `src/fox/reportClient.ts`, `migrations/001_init.sql` (`meter_readings` table).

---

## 4. Token lifecycle

### Encryption at rest

`src/lib/crypto.ts` provides `encrypt()`/`decrypt()` using **AES-256-GCM**.
Both `fox_access_token` and `fox_refresh_token` are always stored encrypted
— the callback (`oauth.ts`) encrypts before the `UPDATE`, and every job that
needs to use a token (`poll.ts`, `refresh-tokens.ts`) decrypts it in memory
just before use and never writes plaintext back to the database or logs it.

Encryption details:
- The key comes from `ENCRYPTION_KEY` (base64-encoded, must decode to
  exactly 32 bytes — i.e. a real AES-256 key, generated with
  `openssl rand -base64 32`). `getKey()` throws immediately if the decoded
  length isn't 32 bytes.
- Each call to `encrypt()` generates a fresh random 12-byte IV
  (`randomBytes(12)`).
- Output packs `iv (12 bytes) + authTag (16 bytes) + ciphertext` into one
  buffer, then base64-encodes the whole thing into a single string — this is
  why `fox_access_token`/`fox_refresh_token` are plain `TEXT` columns rather
  than needing separate IV/tag columns.
- `decrypt()` reverses this by slicing the base64-decoded buffer back into
  its three parts and calling `decipher.setAuthTag()` before finalizing —
  GCM's authentication tag means a tampered or corrupted ciphertext (or a
  wrong key) throws rather than silently returning garbage.

### Expiry and the refresh job

`fox_token_expires_at` is set from Fox's `expires_in` response field
(defaulting to 3600 seconds / 1 hour if Fox omits it) both at initial
exchange and at every refresh.

`src/jobs/refresh-tokens.ts` (`npm run refresh-tokens`) is a separate
standalone script, meant to be scheduled independently of the poller. Each
run:

1. Selects every property where `fox_refresh_token IS NOT NULL AND fox_token_expires_at < now() + interval '60 minutes'`
   — i.e., anything expiring within the next hour (`REFRESH_WINDOW_MINUTES = 60`).
2. For each, decrypts the refresh token, calls `refreshTokens(refreshToken)`,
   and overwrites `fox_access_token`, `fox_refresh_token`, and
   `fox_token_expires_at` with the new (re-encrypted) values.
3. Logs success/failure per property; a failure for one property doesn't
   stop the others (`try`/`catch` inside the loop, same pattern as the
   poller).

This is a proactive, timer-driven refresh — the design explicitly avoids
refreshing lazily/on-demand inside the poll path, so a token that's about to
expire can't silently cause the *next* poll to fail. As with the poller,
there is no cron/worker actually wired up in `render.yaml` yet to invoke
`npm run refresh-tokens` on a schedule — that has to be configured against
the real deployment.

The refresh call (`refreshTokens()` in `src/fox/client.ts`) POSTs
form-encoded data to `{FOX_DOMAIN}/oauth2/refresh`:

```
grant_type=refresh_token
refresh_token={refreshToken}
client_id={FOX_CLIENT_ID}
client_secret={FOX_CLIENT_SECRET}
```

and parses the response the same way as the initial token exchange
(`parseTokenResponse` is shared by both). Note that Fox issuing a **new**
refresh token on every refresh (rather than keeping the same one) is assumed
here — the code always overwrites `fox_refresh_token` with whatever
`refresh_token` came back, so if Fox's real behavior is to return the same
refresh token unchanged, nothing breaks, but if Fox invalidates old refresh
tokens on rotation, this needs to work correctly — it hasn't been tested
against Fox's real behavior.

**Relevant files:** `src/lib/crypto.ts`, `src/jobs/refresh-tokens.ts`, `src/fox/client.ts`, `migrations/001_init.sql`.

---

## 5. Environment variables

From `.env.example` and `src/config/env.ts` (which throws at startup if a
required one is missing):

```
FOX_DOMAIN=https://www.foxesscloud.com    # optional — this is the default if unset
FOX_CLIENT_ID=                            # required
FOX_CLIENT_SECRET=                        # required
FOX_REDIRECT_URI=http://localhost:3000/oauth/fox/callback   # required
FOX_SCOPE=                                # optional — omitted from the authorize URL entirely if blank

ENCRYPTION_KEY=                           # required — openssl rand -base64 32
```

- **`FOX_DOMAIN`** — the base URL for all Fox API calls (authorize page,
  token endpoint, refresh endpoint, report endpoint). Defaults to
  `https://www.foxesscloud.com` if not set, which is Fox's real production
  domain — there's no separate sandbox domain configured anywhere in this
  codebase, so pointing this at a Fox sandbox (if one exists) would mean
  overriding this variable.
- **`FOX_CLIENT_ID`** / **`FOX_CLIENT_SECRET`** — obtained by registering a
  single Fox Open API client in Fox's developer portal (spec §4.1 point 1;
  README's "Known gaps" reiterates this is still a placeholder pending UT's
  real registration). This is **one shared client for the whole
  application** — not per-property or per-tenant. Per-tenant authorization
  happens through the OAuth consent flow (§2), not through separate client
  credentials.
- **`FOX_REDIRECT_URI`** — must exactly match what's registered against the
  `client_id` in Fox's developer portal, and must point at this app's
  `/oauth/fox/callback` route (publicly reachable, since Fox's own servers
  redirect the tenant's browser here).
- **`FOX_SCOPE`** — optional; only appended to the authorize URL if set.
  Fox's required scope value(s), if any, aren't specified anywhere in this
  codebase — this would need to come from Fox's developer portal/docs when
  registering the client.
- **`ENCRYPTION_KEY`** — not Fox-specific, but load-bearing for the whole
  integration since it's what protects every stored Fox token. Must decode
  (base64) to exactly 32 bytes.

None of these have real values checked into the repo — `.env.example` ships
with all Fox fields blank, and every environment (dev, and presumably
whatever's configured on Render) needs its own real values supplied
out-of-band.

**Relevant files:** `.env.example`, `src/config/env.ts`.

---

## 6. Error handling: offline devices, revoked access, and property status

There's no Fox-side webhook or push notification for "device offline" or
"tenant revoked access" in this codebase — the integration only finds out
about these situations indirectly, through poll failures or missing data.

### What actually happens today

- If a poll's `queryDeviceReport()` call fails (network error, non-2xx
  status, non-zero `errno`, or a JSON parse failure), `poll.ts` catches it
  per-property (`try`/`catch` inside the loop), logs
  `Failed to poll property {id}: {err}`, and moves on to the next property.
  **No row is written to `meter_readings` for that cycle.** The failure
  isn't otherwise recorded (e.g. there's no `last_poll_error` column) — it
  only exists in process logs unless something else is watching them.
- The same pattern applies to `refresh-tokens.ts`: a failed refresh (e.g.
  because the tenant revoked Fox access, which would presumably make Fox
  reject the refresh_token grant) is caught, logged, and skipped — the old,
  now-stale token stays in the `properties` row.
- If a property's access token has expired and the refresh job hasn't
  (or can't) renew it, the *next* poll will fail with whatever error Fox's
  API returns for an invalid/expired token — again just logged, not
  surfaced anywhere structured.

### How this surfaces to a human: `src/dashboard/propertyStatus.ts`

This is the closest thing to health monitoring for the Fox connection. It
computes a `PropertyStatus` for each property, checked in this order:

1. **`not_connected`** — `fox_access_token` is still null (OAuth never
   completed). Required action: send the tenant the Fox consent link.
2. **`no_tenant`** — Fox is linked, but `tenant_email` isn't set yet.
3. **`awaiting_data`** — linked and has a tenant, but no `meter_readings` row
   exists yet at all. Required action: "wait for the next 15-minute poll."
4. **`disconnected`** — the last `meter_readings` row is more than
   **48 hours** old (`STALE_READING_HOURS`), or the last `daily_rollups` row
   is more than **2 days** old (`STALE_ROLLUP_DAYS`). Required action text
   explicitly suggests checking "the Fox device is online" or whether "the
   tenant's Fox account authorization hasn't been revoked" — this is the one
   place in the code that names token revocation as a likely cause, but it's
   a guess surfaced to a human, not something the system distinguishes from
   (say) a genuinely offline inverter or a broken CT clamp.
5. **`ok`** — none of the above; readings and rollups are both recent.

This computation is driven purely by staleness of data already in Postgres —
it never calls Fox to actively check device or token status. It's consumed
by `GET /portfolio/summary` and rendered as a colored status pill in
`public/portfolio.html`, with the `requiredActions` text shown in a modal
when an admin/HA user clicks a non-OK property.

### What this means practically

If a tenant revokes Fox access from their own Fox Cloud account, or the
inverter genuinely goes offline, nothing in this codebase detects that
immediately or specifically — it will manifest as poll/refresh failures in
the logs, and after enough time has passed without new data, the property's
status will flip to `disconnected` in the portfolio view. There's no
distinct "access revoked" status, no automated re-notification to the
tenant, and no alerting/paging on poll failures beyond `console.error`/`console.warn` — this would be a reasonable gap to close before real go-live if UT wants proactive alerting rather than only after-the-fact status pills.

**Relevant files:** `src/dashboard/propertyStatus.ts`, `src/jobs/poll.ts`, `src/jobs/refresh-tokens.ts`.

---

## 7. Testing locally

There is no mock Fox server checked into this repository. The README states
the OAuth flow and the poller were each "verified end-to-end locally against
a mock Fox server standing in for foxesscloud.com" / "a mock report
endpoint," but that mock server itself isn't part of the committed source
tree — it was evidently a throwaway harness used during development, not a
reusable fixture. If you need one, you'd have to build it fresh; here's what
it would need to support, based on exactly what the real code calls:

1. **An authorize page** at `GET /h5/auth/foxessIndex` — doesn't need to do
   anything real; a script that immediately redirects to
   `{redirect_uri}?code=test-code&state={state}` is enough to exercise the
   callback path.
2. **`POST /oauth2/token`** — accept the form body described in §2 and
   return `{ "access_token": "...", "refresh_token": "...", "expires_in": 3600 }`.
3. **`POST /oauth2/refresh`** — same shape, accepting the refresh-token form
   body from §4.
4. **`POST /op/v0/device/report/query`** — accept the JSON body from §3 and
   return the `{ errno: 0, result: [{ deviceSN, datas: [...] }] }` shape,
   with synthetic hourly datapoints for each of the six variables so the
   reconciliation math in `poll.ts` can be checked (including deliberately
   unbalancing the numbers to confirm the reconciliation warning fires).

To point the app at such a stand-in instead of real Fox, set
`FOX_DOMAIN=http://localhost:{mock-port}` in `.env` (all three client calls
in `client.ts`/`reportClient.ts` resolve paths against `env.FOX_DOMAIN` via
`new URL(path, env.FOX_DOMAIN)`, so this one variable is sufficient to
redirect every Fox call). `FOX_CLIENT_ID`/`FOX_CLIENT_SECRET`/`FOX_REDIRECT_URI`
can be any non-empty values since a mock server presumably won't validate
them meaningfully unless you choose to make it.

A practical local test loop, once a mock is standing in:

1. `npm run migrate` against a local Postgres.
2. Create a property via `POST /admin/properties` (needs `ADMIN_API_KEY`).
3. Hit the returned `foxAuthorizeUrl` in a browser — with a mock server this
   should round-trip through to `{status: 'ok', message: 'Fox account linked'}`.
4. Confirm `fox_access_token`/`fox_refresh_token`/`fox_token_expires_at`
   are populated (encrypted) on the `properties` row.
5. Run `npm run poll` and confirm a `meter_readings` row appears.
6. Run `npm run rollup` and confirm a `daily_rollups` row appears.
7. To test the refresh job specifically, manually set
   `fox_token_expires_at` to within the next hour and run
   `npm run refresh-tokens`; confirm the token columns change.

**Relevant files:** none currently in-repo for the mock itself — this section describes what to build, based on README claims and the real client code's exact request/response shapes.

---

## 8. Known gaps — what needs confirming with Fox's real sandbox before go-live

This section consolidates every place the code (and the README) flags an
assumption made from Fox's *public* documentation rather than a verified,
live Fox sandbox response. Per the README, the intent is that only
`src/fox/client.ts` and `src/fox/reportClient.ts` should need to change if
any of these turn out to be wrong — nothing else in the pipeline (encryption,
storage, polling cadence, rollup, dashboard) depends on the specifics below.

1. **Token response field names** — `parseTokenResponse()` in `client.ts`
   assumes standard OAuth2 field names: `access_token`, `refresh_token`,
   `expires_in`. Fox's public docs don't give a fully explicit schema for
   this. If Fox's real response uses different field names or nesting, this
   function needs updating.
2. **Token endpoint paths** — `/oauth2/token` and `/oauth2/refresh` are
   assumed paths, not confirmed against Fox's sandbox/Postman collection.
3. **Authorize page path and params** — `/h5/auth/foxessIndex` with
   `response_type`/`client_id`/`redirect_uri`/`scope`/`state` follows the
   spec doc's stated URL pattern; not separately re-verified here.
4. **Report endpoint's hourly datapoint semantics** — `reportClient.ts`
   sums each hourly datapoint's `value` on the assumption they're per-hour
   *increments*. If Fox actually returns a running cumulative total per
   point, summing them would badly overcount. This needs checking against a
   real device's actual response the first time this runs live.
5. **OAuth-mode request signing** — the `signature` header
   (`md5("{path}\r\n{accessToken}\r\n{timestamp}")`) substitutes the OAuth
   access token into Fox's private-key signing formula. This is the code's
   best inference from the docs about how signing works once you're in
   OAuth mode (as opposed to Fox's simpler API-key mode) — it has not been
   validated against a real Fox response and could be wrong in either the
   formula or which fields get signed.
6. **Refresh token rotation behavior** — assumed Fox returns a usable
   `refresh_token` on every refresh call and the old one can be safely
   discarded; not confirmed whether Fox rotates, reuses, or expires refresh
   tokens differently.
7. **Fox scope value(s)** — `FOX_SCOPE` exists as a passthrough env var with
   no default and no documented value in this codebase; whatever Fox
   requires needs to come from their developer portal.
8. **No real Fox sandbox has been exercised** — every "verified end-to-end"
   claim for the OAuth flow and poller (per the README) was checked against
   a local mock standing in for `foxesscloud.com`, not the real service.

Beyond the Fox-specific items above, two adjacent things worth flagging for
anyone taking this to production, both already noted in the README:

- **`render.yaml` doesn't yet define a worker/cron service** for
  `npm run poll` or `npm run refresh-tokens` (see §3/§4) — these scripts
  exist and work when invoked, but nothing currently invokes them
  automatically on the real deployment target.
- **No proactive alerting** on poll/refresh failures (see §6) — failures are
  logged, not surfaced until a property's status pill flips to
  `disconnected`, which can take up to 48 hours.

**Relevant files:** `src/fox/client.ts`, `src/fox/reportClient.ts`, `render.yaml`, `README.md` ("Known gaps before real go-live").

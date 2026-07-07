-- HA/LA portfolio model (spec §9a.2). Deliberately built after individual
-- tenant dashboards work (§10 step 8) — portfolio rollups depend on the same
-- daily_rollups data already being correct.
CREATE TABLE organizations (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('HA', 'LA', 'other')),
  logo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE properties ADD COLUMN organization_id BIGINT REFERENCES organizations(id);

CREATE TABLE organization_users (
  id BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('portfolio_viewer', 'portfolio_admin', 'drilldown_viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_organization_users_email ON organization_users (email);

-- Org-user auth mirrors tenant magic-link auth (§9a.3: "same isolation
-- principle as tenant access, one level up") — a separate session type so an
-- org user's token can never resolve to a property_id or vice versa.
CREATE TABLE org_magic_links (
  id BIGSERIAL PRIMARY KEY,
  organization_user_id BIGINT NOT NULL REFERENCES organization_users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE org_sessions (
  id BIGSERIAL PRIMARY KEY,
  organization_user_id BIGINT NOT NULL REFERENCES organization_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_org_sessions_user ON org_sessions (organization_user_id);

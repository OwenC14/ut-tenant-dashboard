-- Tenant dashboard auth (spec §8: separate from the Fox OAuth token) —
-- magic link via email. Nullable/partial-unique tenant_email since it may
-- be captured at a different point in onboarding than the Fox OAuth step.
ALTER TABLE properties ADD COLUMN tenant_email TEXT;
CREATE UNIQUE INDEX idx_properties_tenant_email ON properties (tenant_email) WHERE tenant_email IS NOT NULL;

CREATE TABLE magic_links (
  id BIGSERIAL PRIMARY KEY,
  property_id BIGINT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id BIGSERIAL PRIMARY KEY,
  property_id BIGINT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_property ON sessions (property_id);

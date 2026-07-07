-- Two-tier admin accounts, replacing the single shared ADMIN_API_KEY for
-- day-to-day use. super_admin can manage the team itself; install_staff can
-- onboard properties/organizations but not add or remove other admins.
-- ADMIN_API_KEY remains as a break-glass/bootstrap credential (see README) --
-- it's how the very first super_admin gets created, since creating one
-- normally requires already being a super_admin.
CREATE TABLE admin_users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'install_staff')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_admin_users_email ON admin_users (email);

-- Mirrors tenant/org magic-link auth (src/auth/session.ts, src/auth/orgSession.ts)
-- for consistency -- a separate token/session type so it can never resolve to
-- a propertyId or organizationId.
CREATE TABLE admin_magic_links (
  id BIGSERIAL PRIMARY KEY,
  admin_user_id BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
  id BIGSERIAL PRIMARY KEY,
  admin_user_id BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_sessions_user ON admin_sessions (admin_user_id);

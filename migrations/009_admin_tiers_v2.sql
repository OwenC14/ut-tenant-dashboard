-- Backend Interface spec: three tiers -- super_admin (all access), operations
-- (renamed from install_staff -- manages properties/tenants for their
-- assigned clients only), and installer (read-only, scoped to their
-- assigned clients; an installer with zero assignments is treated as a
-- Union Technical installer and can see every client, per spec: "In the
-- case that it is not Union Technical, who can see all, installers will
-- only see the data relating to their installs/clients").
ALTER TABLE admin_users DROP CONSTRAINT admin_users_role_check;
UPDATE admin_users SET role = 'operations' WHERE role = 'install_staff';
ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check CHECK (role IN ('super_admin', 'operations', 'installer'));

-- Which admin_users (operations or installer) can act on which organizations
-- ("clients"). Multiple staff can be assigned to one client (spec: "Multiple
-- operations staff can be added to each client"); super_admin rows are never
-- inserted here since that role bypasses scoping entirely.
CREATE TABLE admin_client_assignments (
  id BIGSERIAL PRIMARY KEY,
  admin_user_id BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admin_user_id, organization_id)
);
CREATE INDEX idx_admin_client_assignments_admin ON admin_client_assignments (admin_user_id);
CREATE INDEX idx_admin_client_assignments_org ON admin_client_assignments (organization_id);

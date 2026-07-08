import { randomBytes } from 'crypto';
import { Router } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../lib/asyncHandler';
import { requireAdmin } from '../auth/requireAdmin';
import { requireSuperAdmin } from '../auth/requireSuperAdmin';
import { resolveAdminClientScope, blockInstallerWrites, AdminClientScope } from '../auth/adminScope';
import { isUniqueViolation, uniqueViolationConstraint } from '../lib/db';
import { env } from '../config/env';

function scopeIncludes(scope: AdminClientScope, organizationId: number | null): boolean {
  if (scope === 'all') return true;
  return organizationId !== null && scope.includes(organizationId);
}

export const adminRouter = Router();
adminRouter.use(requireAdmin);

adminRouter.get('/me', (req, res) => {
  res.json({ adminUserId: req.adminUserId ?? null, role: req.adminRole });
});

interface PropertyInput {
  address?: string;
  postcode?: string;
  tenantName?: string;
  foxDeviceSn?: string;
  tenantEmail?: string;
  arraySizeKwp?: number;
  batteryCapacityKwh?: number;
  installDate?: string;
  haOrLaPartner?: string;
  organizationId?: number;
}

function validate(input: PropertyInput): string | null {
  if (!input.address) return 'address is required';
  if (!input.tenantName) return 'tenantName is required';
  if (!input.foxDeviceSn) return 'foxDeviceSn is required';
  return null;
}

// Excludes visually-ambiguous characters (0/O, 1/I) since this gets
// handwritten on install paperwork and typed back in by a tenant.
const SIGNUP_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateSignupCode(): string {
  const bytes = randomBytes(5);
  let code = 'UT-';
  for (let i = 0; i < 5; i++) code += SIGNUP_CODE_CHARS[bytes[i] % SIGNUP_CODE_CHARS.length];
  return code;
}

async function createProperty(input: PropertyInput) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const signupCode = generateSignupCode();
    try {
      const { rows } = await pool.query(
        `INSERT INTO properties
           (address, postcode, tenant_name, fox_device_sn, tenant_email, array_size_kwp, battery_capacity_kwh, install_date, ha_or_la_partner, signup_code, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          input.address,
          input.postcode ?? null,
          input.tenantName,
          input.foxDeviceSn,
          input.tenantEmail ?? null,
          input.arraySizeKwp ?? null,
          input.batteryCapacityKwh ?? null,
          input.installDate ?? null,
          input.haOrLaPartner ?? null,
          signupCode,
          input.organizationId ?? null,
        ]
      );
      const id = rows[0].id;
      return {
        id,
        signupCode,
        foxAuthorizeUrl: new URL(`/oauth/fox/authorize?propertyId=${id}`, env.APP_BASE_URL).toString(),
      };
    } catch (err) {
      // Collision on the random signup_code itself (astronomically unlikely
      // at pilot scale) is worth a quiet retry; any other unique violation
      // (device SN / tenant email) is a real conflict — surface it.
      if (isUniqueViolation(err) && uniqueViolationConstraint(err) === 'idx_properties_signup_code') {
        continue;
      }
      throw err;
    }
  }
  throw new Error('failed to generate a unique signup code after 5 attempts');
}

adminRouter.post(
  '/properties',
  blockInstallerWrites,
  asyncHandler(async (req, res) => {
    const input: PropertyInput = req.body ?? {};
    const error = validate(input);
    if (error) {
      res.status(400).json({ error });
      return;
    }

    // Operations staff only manage the clients they've been assigned --
    // super_admin can create for any client, or none at all.
    if (req.adminRole === 'operations') {
      const scope = await resolveAdminClientScope(req);
      if (!scopeIncludes(scope, input.organizationId ?? null)) {
        res.status(403).json({ error: 'you are not assigned to that client' });
        return;
      }
    }

    try {
      const result = await createProperty(input);
      res.status(201).json(result);
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'a property with that device serial number or tenant email already exists' });
        return;
      }
      throw err;
    }
  })
);

// Onboarding "at scale" (§10 step 7): create many properties in one call
// instead of one-by-one, without needing a CSV parser — one bad row doesn't
// abort the rest of the batch.
adminRouter.post(
  '/properties/bulk',
  blockInstallerWrites,
  asyncHandler(async (req, res) => {
    const properties: PropertyInput[] = req.body?.properties;
    if (!Array.isArray(properties) || properties.length === 0) {
      res.status(400).json({ error: 'properties must be a non-empty array' });
      return;
    }

    const scope = req.adminRole === 'operations' ? await resolveAdminClientScope(req) : 'all';

    const results = [];
    for (const [index, input] of properties.entries()) {
      const error = validate(input);
      if (error) {
        results.push({ index, status: 'error', error });
        continue;
      }
      if (!scopeIncludes(scope, input.organizationId ?? null)) {
        results.push({ index, status: 'error', error: 'you are not assigned to that client' });
        continue;
      }
      try {
        const created = await createProperty(input);
        results.push({ index, status: 'created', ...created });
      } catch (err) {
        results.push({
          index,
          status: 'error',
          error: isUniqueViolation(err) ? 'duplicate device serial number or tenant email' : 'unexpected error',
        });
      }
    }

    res.json({ results });
  })
);

adminRouter.get(
  '/properties',
  asyncHandler(async (req, res) => {
    // Unassigned properties (organization_id IS NULL) are super_admin-only --
    // operations/installer are scoped to specific clients, and an unassigned
    // property isn't any client's yet.
    const scope = await resolveAdminClientScope(req);
    const scopeClause = scope === 'all' ? '' : 'WHERE p.organization_id = ANY($1::bigint[])';

    const { rows } = await pool.query(
      `SELECT
        p.id, p.address, p.postcode, p.tenant_name, p.fox_device_sn, p.tenant_email, p.organization_id, p.signup_code,
        p.connection_date,
        o.name AS organization_name,
        p.fox_access_token IS NOT NULL AS has_fox_token,
        (SELECT MAX(reading_time) FROM meter_readings WHERE property_id = p.id) AS last_reading_at,
        (SELECT MAX(date) FROM daily_rollups WHERE property_id = p.id) AS last_rollup_date
      FROM properties p
      LEFT JOIN organizations o ON o.id = p.organization_id
      ${scopeClause}
      ORDER BY o.name NULLS LAST, p.created_at DESC`,
      scope === 'all' ? [] : [scope]
    );
    res.json({ properties: rows });
  })
);

// General field completion -- lets staff fill in whatever a batch CSV import
// left blank (postcode, tenant email, array/battery sizing) without a
// separate "edit property" page.
interface PropertyPatchInput {
  postcode?: string;
  tenantEmail?: string;
  arraySizeKwp?: number;
  batteryCapacityKwh?: number;
}

adminRouter.patch(
  '/properties/:id',
  blockInstallerWrites,
  asyncHandler(async (req, res) => {
    const propertyId = Number(req.params.id);
    if (!Number.isInteger(propertyId)) {
      res.status(400).json({ error: 'invalid property id' });
      return;
    }

    if (req.adminRole === 'operations') {
      const scope = await resolveAdminClientScope(req);
      const { rows: propRows } = await pool.query('SELECT organization_id FROM properties WHERE id = $1', [propertyId]);
      if (propRows.length === 0) {
        res.status(404).json({ error: 'property not found' });
        return;
      }
      if (!scopeIncludes(scope, propRows[0].organization_id)) {
        res.status(403).json({ error: 'you are not assigned to that client' });
        return;
      }
    }

    const input: PropertyPatchInput = req.body ?? {};
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (input.postcode !== undefined) { fields.push(`postcode = $${i++}`); values.push(input.postcode || null); }
    if (input.tenantEmail !== undefined) { fields.push(`tenant_email = $${i++}`); values.push(input.tenantEmail || null); }
    if (input.arraySizeKwp !== undefined) { fields.push(`array_size_kwp = $${i++}`); values.push(input.arraySizeKwp); }
    if (input.batteryCapacityKwh !== undefined) { fields.push(`battery_capacity_kwh = $${i++}`); values.push(input.batteryCapacityKwh); }
    if (fields.length === 0) {
      res.status(400).json({ error: 'nothing to update' });
      return;
    }
    values.push(propertyId);

    try {
      const { rows } = await pool.query(
        `UPDATE properties SET ${fields.join(', ')} WHERE id = $${i} RETURNING id, postcode, tenant_email, array_size_kwp, battery_capacity_kwh`,
        values
      );
      if (rows.length === 0) {
        res.status(404).json({ error: 'property not found' });
        return;
      }
      res.json(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'a property with that tenant email already exists' });
        return;
      }
      throw err;
    }
  })
);

// Reassigning a property between clients is a cross-client action, out of
// scope for a single operations/installer assignment -- super_admin only.
adminRouter.patch(
  '/properties/:id/organization',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const propertyId = Number(req.params.id);
    const organizationId = req.body?.organizationId === null ? null : Number(req.body?.organizationId);
    if (!Number.isInteger(propertyId)) {
      res.status(400).json({ error: 'invalid property id' });
      return;
    }
    if (organizationId !== null && !Number.isInteger(organizationId)) {
      res.status(400).json({ error: 'organizationId must be an integer or null' });
      return;
    }

    const { rows } = await pool.query(
      'UPDATE properties SET organization_id = $1 WHERE id = $2 RETURNING id, organization_id',
      [organizationId, propertyId]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'property not found' });
      return;
    }
    res.json(rows[0]);
  })
);

interface OrganizationInput {
  name?: string;
  type?: string;
  logoUrl?: string;
}

const ORG_TYPES = ['HA', 'LA', 'other'];

// Creating a new client is a super_admin action -- clients get assigned to
// operations/installer staff afterward (see the /organizations/:id/assignments
// endpoints below), rather than operations onboarding their own clients.
adminRouter.post(
  '/organizations',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const input: OrganizationInput = req.body ?? {};
    if (!input.name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!input.type || !ORG_TYPES.includes(input.type)) {
      res.status(400).json({ error: `type must be one of: ${ORG_TYPES.join(', ')}` });
      return;
    }

    const { rows } = await pool.query(
      'INSERT INTO organizations (name, type, logo_url) VALUES ($1, $2, $3) RETURNING id',
      [input.name, input.type, input.logoUrl ?? null]
    );
    res.status(201).json({ id: rows[0].id });
  })
);

adminRouter.get(
  '/organizations',
  asyncHandler(async (req, res) => {
    const scope = await resolveAdminClientScope(req);
    const scopeClause = scope === 'all' ? '' : 'WHERE o.id = ANY($1::bigint[])';

    const { rows } = await pool.query(
      `SELECT o.id, o.name, o.type,
             (SELECT COUNT(*) FROM properties WHERE organization_id = o.id) AS property_count
      FROM organizations o
      ${scopeClause}
      ORDER BY o.created_at DESC`,
      scope === 'all' ? [] : [scope]
    );
    res.json({ organizations: rows });
  })
);

interface OrgUserInput {
  name?: string;
  email?: string;
  role?: string;
}

const ORG_ROLES = ['portfolio_viewer', 'portfolio_admin', 'drilldown_viewer'];

adminRouter.post(
  '/organizations/:id/users',
  blockInstallerWrites,
  asyncHandler(async (req, res) => {
    const organizationId = Number(req.params.id);
    const input: OrgUserInput = req.body ?? {};
    if (!Number.isInteger(organizationId)) {
      res.status(400).json({ error: 'invalid organization id' });
      return;
    }
    if (req.adminRole === 'operations') {
      const scope = await resolveAdminClientScope(req);
      if (!scopeIncludes(scope, organizationId)) {
        res.status(403).json({ error: 'you are not assigned to that client' });
        return;
      }
    }
    if (!input.name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!input.email) {
      res.status(400).json({ error: 'email is required' });
      return;
    }
    if (!input.role || !ORG_ROLES.includes(input.role)) {
      res.status(400).json({ error: `role must be one of: ${ORG_ROLES.join(', ')}` });
      return;
    }

    try {
      const { rows } = await pool.query(
        'INSERT INTO organization_users (organization_id, name, email, role) VALUES ($1, $2, $3, $4) RETURNING id',
        [organizationId, input.name, input.email.trim().toLowerCase(), input.role]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'a user with that email already exists' });
        return;
      }
      throw err;
    }
  })
);

// Client assignments (Backend Interface spec) — which operations/installer
// staff can act on which clients. super_admin only: assigning staff to
// clients is how a super_admin delegates scope, so it can't be self-service.
adminRouter.get(
  '/organizations/:id/assignments',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const organizationId = Number(req.params.id);
    if (!Number.isInteger(organizationId)) {
      res.status(400).json({ error: 'invalid organization id' });
      return;
    }
    const { rows } = await pool.query(
      `SELECT au.id, au.name, au.email, au.role
       FROM admin_client_assignments aca
       JOIN admin_users au ON au.id = aca.admin_user_id
       WHERE aca.organization_id = $1
       ORDER BY au.name`,
      [organizationId]
    );
    res.json({ assignments: rows });
  })
);

adminRouter.post(
  '/organizations/:id/assignments',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const organizationId = Number(req.params.id);
    const adminUserId = Number(req.body?.adminUserId);
    if (!Number.isInteger(organizationId) || !Number.isInteger(adminUserId)) {
      res.status(400).json({ error: 'organizationId and adminUserId must both be integers' });
      return;
    }

    const { rows: userRows } = await pool.query('SELECT role FROM admin_users WHERE id = $1', [adminUserId]);
    if (userRows.length === 0) {
      res.status(404).json({ error: 'admin user not found' });
      return;
    }
    if (userRows[0].role === 'super_admin') {
      res.status(400).json({ error: 'super_admin already has access to every client — no assignment needed' });
      return;
    }

    try {
      await pool.query(
        'INSERT INTO admin_client_assignments (admin_user_id, organization_id) VALUES ($1, $2)',
        [adminUserId, organizationId]
      );
      res.status(201).json({ status: 'ok' });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'already assigned to this client' });
        return;
      }
      throw err;
    }
  })
);

adminRouter.delete(
  '/organizations/:id/assignments/:adminUserId',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const organizationId = Number(req.params.id);
    const adminUserId = Number(req.params.adminUserId);
    if (!Number.isInteger(organizationId) || !Number.isInteger(adminUserId)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const { rowCount } = await pool.query(
      'DELETE FROM admin_client_assignments WHERE organization_id = $1 AND admin_user_id = $2',
      [organizationId, adminUserId]
    );
    if (rowCount === 0) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ status: 'ok' });
  })
);

// Team management (§ admin tiers) — super_admin only. operations/installer
// can act within their assigned clients (see the scope helpers above and the
// /organizations/:id/assignments endpoints below), but can't add or remove
// admins or change who's assigned to what.
interface AdminUserInput {
  name?: string;
  email?: string;
  role?: string;
}

const ADMIN_ROLES = ['super_admin', 'operations', 'installer'];

adminRouter.get(
  '/team',
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`
      SELECT au.id, au.name, au.email, au.role, au.created_at,
             COALESCE(
               (SELECT array_agg(o.name ORDER BY o.name)
                FROM admin_client_assignments aca
                JOIN organizations o ON o.id = aca.organization_id
                WHERE aca.admin_user_id = au.id),
               ARRAY[]::text[]
             ) AS assigned_clients
      FROM admin_users au
      ORDER BY au.created_at
    `);
    res.json({ team: rows });
  })
);

adminRouter.post(
  '/team',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const input: AdminUserInput = req.body ?? {};
    if (!input.name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!input.email) {
      res.status(400).json({ error: 'email is required' });
      return;
    }
    if (!input.role || !ADMIN_ROLES.includes(input.role)) {
      res.status(400).json({ error: `role must be one of: ${ADMIN_ROLES.join(', ')}` });
      return;
    }

    try {
      const { rows } = await pool.query(
        'INSERT INTO admin_users (name, email, role) VALUES ($1, $2, $3) RETURNING id',
        [input.name, input.email.trim().toLowerCase(), input.role]
      );
      res.status(201).json({ id: rows[0].id });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'a team member with that email already exists' });
        return;
      }
      throw err;
    }
  })
);

adminRouter.delete(
  '/team/:id',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const { rowCount } = await pool.query('DELETE FROM admin_users WHERE id = $1', [id]);
    if (rowCount === 0) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ status: 'ok' });
  })
);

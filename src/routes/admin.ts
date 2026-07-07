import { Router } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../lib/asyncHandler';
import { requireAdmin } from '../auth/requireAdmin';
import { env } from '../config/env';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

interface PropertyInput {
  address?: string;
  tenantName?: string;
  foxDeviceSn?: string;
  tenantEmail?: string;
  arraySizeKwp?: number;
  batteryCapacityKwh?: number;
  installDate?: string;
  haOrLaPartner?: string;
}

function validate(input: PropertyInput): string | null {
  if (!input.address) return 'address is required';
  if (!input.tenantName) return 'tenantName is required';
  if (!input.foxDeviceSn) return 'foxDeviceSn is required';
  return null;
}

async function createProperty(input: PropertyInput) {
  const { rows } = await pool.query(
    `INSERT INTO properties
       (address, tenant_name, fox_device_sn, tenant_email, array_size_kwp, battery_capacity_kwh, install_date, ha_or_la_partner)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.address,
      input.tenantName,
      input.foxDeviceSn,
      input.tenantEmail ?? null,
      input.arraySizeKwp ?? null,
      input.batteryCapacityKwh ?? null,
      input.installDate ?? null,
      input.haOrLaPartner ?? null,
    ]
  );
  const id = rows[0].id;
  return { id, foxAuthorizeUrl: new URL(`/oauth/fox/authorize?propertyId=${id}`, env.APP_BASE_URL).toString() };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

adminRouter.post(
  '/properties',
  asyncHandler(async (req, res) => {
    const error = validate(req.body ?? {});
    if (error) {
      res.status(400).json({ error });
      return;
    }
    try {
      const result = await createProperty(req.body);
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
  asyncHandler(async (req, res) => {
    const properties: PropertyInput[] = req.body?.properties;
    if (!Array.isArray(properties) || properties.length === 0) {
      res.status(400).json({ error: 'properties must be a non-empty array' });
      return;
    }

    const results = [];
    for (const [index, input] of properties.entries()) {
      const error = validate(input);
      if (error) {
        results.push({ index, status: 'error', error });
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
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`
      SELECT
        p.id, p.address, p.tenant_name, p.fox_device_sn, p.tenant_email, p.organization_id,
        p.fox_access_token IS NOT NULL AS has_fox_token,
        (SELECT MAX(reading_time) FROM meter_readings WHERE property_id = p.id) AS last_reading_at,
        (SELECT MAX(date) FROM daily_rollups WHERE property_id = p.id) AS last_rollup_date
      FROM properties p
      ORDER BY p.created_at DESC
    `);
    res.json({ properties: rows });
  })
);

adminRouter.patch(
  '/properties/:id/organization',
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

adminRouter.post(
  '/organizations',
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
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(`
      SELECT o.id, o.name, o.type,
             (SELECT COUNT(*) FROM properties WHERE organization_id = o.id) AS property_count
      FROM organizations o
      ORDER BY o.created_at DESC
    `);
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
  asyncHandler(async (req, res) => {
    const organizationId = Number(req.params.id);
    const input: OrgUserInput = req.body ?? {};
    if (!Number.isInteger(organizationId)) {
      res.status(400).json({ error: 'invalid organization id' });
      return;
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

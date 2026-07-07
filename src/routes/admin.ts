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
        p.id, p.address, p.tenant_name, p.fox_device_sn, p.tenant_email,
        p.fox_access_token IS NOT NULL AS has_fox_token,
        (SELECT MAX(reading_time) FROM meter_readings WHERE property_id = p.id) AS last_reading_at,
        (SELECT MAX(date) FROM daily_rollups WHERE property_id = p.id) AS last_rollup_date
      FROM properties p
      ORDER BY p.created_at DESC
    `);
    res.json({ properties: rows });
  })
);

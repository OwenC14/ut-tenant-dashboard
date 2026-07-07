import { Router } from 'express';
import { pool } from '../db/pool';
import { requireOrgSession } from '../auth/requireOrgSession';
import { asyncHandler } from '../lib/asyncHandler';
import { getCurrentAgreement, getCurrentConsentStatus } from '../consent/agreements';
import { getPropertyAggregate } from '../dashboard/aggregate';

const DRILLDOWN_WINDOW_DAYS = 28;

export const portfolioRouter = Router();

const PORTFOLIO_WINDOW_DAYS = 28;
const STALE_READING_HOURS = 48;
const STALE_ROLLUP_DAYS = 2;

interface PortfolioTotalsRow {
  solar_kwh: string | null;
  battery_kwh: string | null;
  grid_kwh: string | null;
  current_bill: string | null;
  new_bill: string | null;
  properties_with_data: string;
}

interface PropertyRow {
  id: number;
  address: string;
  tenant_name: string;
  last_reading_at: string | null;
  last_rollup_date: string | null;
}

portfolioRouter.get(
  '/summary',
  requireOrgSession,
  asyncHandler(async (req, res) => {
    const organizationId = req.org!.organizationId;

    const { rows: orgRows } = await pool.query('SELECT id, name, type FROM organizations WHERE id = $1', [organizationId]);
    if (orgRows.length === 0) {
      res.status(404).json({ error: 'organization not found' });
      return;
    }

    const { rows: propertyRows } = await pool.query<PropertyRow>(
      `SELECT p.id, p.address, p.tenant_name,
              (SELECT MAX(reading_time) FROM meter_readings WHERE property_id = p.id) AS last_reading_at,
              (SELECT MAX(date) FROM daily_rollups WHERE property_id = p.id) AS last_rollup_date
       FROM properties p
       WHERE p.organization_id = $1
       ORDER BY p.address`,
      [organizationId]
    );

    const { rows: latestRows } = await pool.query(
      `SELECT MAX(dr.date) AS latest
       FROM daily_rollups dr
       JOIN properties p ON p.id = dr.property_id
       WHERE p.organization_id = $1`,
      [organizationId]
    );
    const latest = latestRows[0]?.latest;

    let totals = { solarKwh: 0, batteryKwh: 0, gridKwh: 0, currentBill: 0, newBill: 0, saving: 0, propertiesWithData: 0 };
    let period: { start: string | null; end: string | null; days: number } = { start: null, end: null, days: 0 };

    if (latest) {
      const { rows: totalsRows } = await pool.query<PortfolioTotalsRow>(
        `SELECT
           SUM(dr.solar_self_consumed_kwh) AS solar_kwh,
           SUM(dr.battery_covered_kwh) AS battery_kwh,
           SUM(dr.grid_covered_kwh) AS grid_kwh,
           SUM(dr.estimated_cost_current_bill) AS current_bill,
           SUM(dr.estimated_cost_new_bill) AS new_bill,
           COUNT(DISTINCT dr.property_id) AS properties_with_data
         FROM daily_rollups dr
         JOIN properties p ON p.id = dr.property_id
         WHERE p.organization_id = $1
           AND dr.date > $2::date - ('${PORTFOLIO_WINDOW_DAYS}' || ' days')::interval
           AND dr.date <= $2::date`,
        [organizationId, latest]
      );
      const t = totalsRows[0];
      const currentBill = Number(t.current_bill ?? 0);
      const newBill = Number(t.new_bill ?? 0);
      totals = {
        solarKwh: Number(t.solar_kwh ?? 0),
        batteryKwh: Number(t.battery_kwh ?? 0),
        gridKwh: Number(t.grid_kwh ?? 0),
        currentBill,
        newBill,
        saving: currentBill - newBill,
        propertiesWithData: Number(t.properties_with_data),
      };
      period = { start: null, end: latest, days: PORTFOLIO_WINDOW_DAYS };
    }

    // Live check (spec §9a.3/§9a.4 point 5: query the current status, never
    // trust a cached/static flag) — one query for the whole org instead of
    // N+1 per property.
    const haAgreement = await getCurrentAgreement('ha_data_sharing');
    let sharedPropertyIds = new Set<number>();
    if (haAgreement && propertyRows.length > 0) {
      const { rows: consentRows } = await pool.query(
        `SELECT DISTINCT ON (property_id) property_id, status
         FROM consent_records
         WHERE agreement_id = $1 AND property_id = ANY($2::bigint[])
         ORDER BY property_id, recorded_at DESC`,
        [haAgreement.id, propertyRows.map((p) => p.id)]
      );
      sharedPropertyIds = new Set(consentRows.filter((r) => r.status === 'accepted').map((r) => r.property_id));
    }

    const now = Date.now();
    const properties = propertyRows.map((p) => {
      const lastReadingAgeHours = p.last_reading_at ? (now - new Date(p.last_reading_at).getTime()) / (1000 * 60 * 60) : Infinity;
      const lastRollupAgeDays = p.last_rollup_date ? (now - new Date(p.last_rollup_date).getTime()) / (1000 * 60 * 60 * 24) : Infinity;
      const flagged = lastReadingAgeHours > STALE_READING_HOURS || lastRollupAgeDays > STALE_ROLLUP_DAYS;

      return {
        id: p.id,
        address: p.address,
        tenantName: p.tenant_name,
        lastReadingAt: p.last_reading_at,
        lastRollupDate: p.last_rollup_date,
        flagged,
        drilldownAvailable: sharedPropertyIds.has(p.id),
      };
    });

    res.json({
      organization: orgRows[0],
      propertyCount: propertyRows.length,
      period,
      totals: {
        ...totals,
        avgSavingPerProperty: totals.propertiesWithData > 0 ? totals.saving / totals.propertiesWithData : 0,
      },
      properties,
    });
  })
);

// Per-property usage-data drill-down (spec §9a.3). Refuses, rather than
// errors, when consent isn't currently 'accepted' — an HA seeing a property
// silently missing would look like a data fault, not a tenant's choice, so
// the response says exactly why (§9a.3: "this tenant has not shared
// individual-level data", not a blank row or a broken link).
portfolioRouter.get(
  '/properties/:id',
  requireOrgSession,
  asyncHandler(async (req, res) => {
    const organizationId = req.org!.organizationId;
    const propertyId = Number(req.params.id);
    if (!Number.isInteger(propertyId)) {
      res.status(400).json({ error: 'invalid property id' });
      return;
    }

    const { rows } = await pool.query(
      'SELECT id, address, tenant_name FROM properties WHERE id = $1 AND organization_id = $2',
      [propertyId, organizationId]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'property not found in this organization' });
      return;
    }

    const consent = await getCurrentConsentStatus(propertyId, 'ha_data_sharing');
    if (!consent || consent.status !== 'accepted') {
      res.status(403).json({
        error: 'not_shared',
        message: 'This tenant has not shared individual-level data.',
      });
      return;
    }

    const aggregate = await getPropertyAggregate(propertyId, DRILLDOWN_WINDOW_DAYS);
    res.json({ property: rows[0], ...aggregate });
  })
);

import { Router } from 'express';
import { pool } from '../db/pool';
import { requireOrgSession } from '../auth/requireOrgSession';
import { asyncHandler } from '../lib/asyncHandler';

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
        // Per-property usage data drill-down requires the tenant's live
        // ha_data_sharing consent (spec §9a.3) — consent_records doesn't
        // exist until §10 step 9, so this is hardcoded false until then.
        // No drill-down without an explicit accepted consent record, ever.
        drilldownAvailable: false,
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

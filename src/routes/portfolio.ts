import { Router } from 'express';
import { pool } from '../db/pool';
import { requireOrgSession } from '../auth/requireOrgSession';
import { asyncHandler } from '../lib/asyncHandler';
import { getCurrentAgreement, getCurrentConsentStatus } from '../consent/agreements';
import { getAggregateForRange, getHourlyAggregate, RANGE_DAYS, DASHBOARD_RANGES, DashboardRange } from '../dashboard/aggregate';
import { computePropertyStatus, STATUS_LABELS } from '../dashboard/propertyStatus';

export const portfolioRouter = Router();

interface PortfolioRollupRow {
  property_id: number;
  date: string;
  solar_self_consumed_kwh: string;
  battery_covered_kwh: string;
  grid_covered_kwh: string;
  estimated_cost_current_bill: string;
  estimated_cost_new_bill: string;
}

interface PropertyRow {
  id: number;
  address: string;
  postcode: string | null;
  tenant_name: string;
  connection_date: string | null;
  has_fox_token: boolean;
  has_tenant_email: boolean;
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
      `SELECT p.id, p.address, p.postcode, p.tenant_name, p.connection_date,
              p.fox_access_token IS NOT NULL AS has_fox_token,
              p.tenant_email IS NOT NULL AS has_tenant_email,
              (SELECT MAX(reading_time) FROM meter_readings WHERE property_id = p.id) AS last_reading_at,
              (SELECT MAX(date) FROM daily_rollups WHERE property_id = p.id) AS last_rollup_date
       FROM properties p
       WHERE p.organization_id = $1
       ORDER BY p.address`,
      [organizationId]
    );

    const range = String(req.query.range ?? 'month');
    if (!DASHBOARD_RANGES.includes(range as DashboardRange)) {
      res.status(400).json({ error: `range must be one of: ${DASHBOARD_RANGES.join(', ')}` });
      return;
    }

    let totals = { solarKwh: 0, batteryKwh: 0, gridKwh: 0, currentBill: 0, newBill: 0, saving: 0, propertiesWithData: 0 };
    let period: { start: string | null; end: string | null; days: number } = { start: null, end: null, days: 0 };
    let series: { date: string; without: number; with: number }[] = [];

    if (range === '24h') {
      // Every property in the org, hour by hour — same cumulative-reading
      // diff logic as a single tenant's 24-hour view (src/dashboard/aggregate.ts),
      // just summed across the whole portfolio instead of one property.
      const agg = await getHourlyAggregate(propertyRows.map((p) => p.id), 24);
      if (agg.hasData) {
        totals = {
          solarKwh: agg.solar?.kwh ?? 0,
          batteryKwh: agg.battery?.kwh ?? 0,
          gridKwh: agg.grid?.kwh ?? 0,
          currentBill: agg.currentBill ?? 0,
          newBill: agg.newBill ?? 0,
          saving: agg.saving ?? 0,
          propertiesWithData: agg.propertiesWithData ?? 0,
        };
        period = { start: agg.periodStart ?? null, end: agg.periodEnd ?? null, days: agg.series?.length ?? 0 };
        series = agg.series ?? [];
      }
    } else {
      const windowDays = RANGE_DAYS[range as Exclude<DashboardRange, '24h'>];

      const { rows: latestRows } = await pool.query(
        `SELECT MAX(dr.date) AS latest
         FROM daily_rollups dr
         JOIN properties p ON p.id = dr.property_id
         WHERE p.organization_id = $1`,
        [organizationId]
      );
      const latest = latestRows[0]?.latest;

      if (latest) {
        // Ungrouped (not SUM'd in SQL) so we can derive both the aggregate
        // totals AND a per-day series — and the distinct property count — from
        // one query instead of two.
        const { rows: rollupRows } = await pool.query<PortfolioRollupRow>(
          `SELECT dr.property_id, dr.date, dr.solar_self_consumed_kwh, dr.battery_covered_kwh, dr.grid_covered_kwh,
                  dr.estimated_cost_current_bill, dr.estimated_cost_new_bill
           FROM daily_rollups dr
           JOIN properties p ON p.id = dr.property_id
           WHERE p.organization_id = $1
             AND dr.date > $2::date - ($3::text || ' days')::interval
             AND dr.date <= $2::date
           ORDER BY dr.date`,
          [organizationId, latest, windowDays]
        );

        const byDate = new Map<string, { without: number; with: number }>();
        const propertiesWithData = new Set<number>();
        let solarKwh = 0;
        let batteryKwh = 0;
        let gridKwh = 0;
        let currentBill = 0;
        let newBill = 0;

        for (const r of rollupRows) {
          propertiesWithData.add(r.property_id);
          solarKwh += Number(r.solar_self_consumed_kwh);
          batteryKwh += Number(r.battery_covered_kwh);
          gridKwh += Number(r.grid_covered_kwh);
          const dayWithout = Number(r.estimated_cost_current_bill);
          const dayWith = Number(r.estimated_cost_new_bill);
          currentBill += dayWithout;
          newBill += dayWith;

          // pg returns `date` columns as JS Date objects — keying a Map by one
          // directly would key on object identity, not calendar-date equality,
          // so two properties' rows for the same date would never merge.
          const dateKey = new Date(r.date).toISOString().slice(0, 10);
          const bucket = byDate.get(dateKey) ?? { without: 0, with: 0 };
          bucket.without += dayWithout;
          bucket.with += dayWith;
          byDate.set(dateKey, bucket);
        }

        series = Array.from(byDate.entries())
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([date, v]) => ({ date, without: v.without, with: v.with }));

        totals = {
          solarKwh,
          batteryKwh,
          gridKwh,
          currentBill,
          newBill,
          saving: currentBill - newBill,
          propertiesWithData: propertiesWithData.size,
        };
        period = { start: series[0]?.date ?? null, end: latest, days: series.length };
      }
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

    const properties = propertyRows.map((p) => {
      const { status, requiredActions } = computePropertyStatus({
        hasFoxToken: p.has_fox_token,
        hasTenantEmail: p.has_tenant_email,
        lastReadingAt: p.last_reading_at,
        lastRollupDate: p.last_rollup_date,
      });

      return {
        id: p.id,
        address: p.address,
        postcode: p.postcode,
        tenantName: p.tenant_name,
        connectionDate: p.connection_date,
        lastReadingAt: p.last_reading_at,
        lastRollupDate: p.last_rollup_date,
        status,
        requiredActions,
        flagged: status !== 'ok', // kept for any older client still reading this field
        drilldownAvailable: sharedPropertyIds.has(p.id),
      };
    });

    res.json({
      organization: orgRows[0],
      propertyCount: propertyRows.length,
      range,
      granularity: range === '24h' ? 'hour' : 'day',
      period,
      totals: {
        ...totals,
        avgSavingPerProperty: totals.propertiesWithData > 0 ? totals.saving / totals.propertiesWithData : 0,
      },
      series,
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
    const range = String(req.query.range ?? 'month');
    if (!DASHBOARD_RANGES.includes(range as DashboardRange)) {
      res.status(400).json({ error: `range must be one of: ${DASHBOARD_RANGES.join(', ')}` });
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

    const aggregate = await getAggregateForRange(propertyId, range as DashboardRange);
    res.json({ property: rows[0], range, granularity: range === '24h' ? 'hour' : 'day', ...aggregate });
  })
);

function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Client interface CSV export — a property-by-property data snapshot
// (solar/battery/grid kWh, bill/saving figures) for the selected range.
// Same consent gate as the drill-down endpoint above: a property's actual
// usage figures only appear here if that tenant has current, accepted
// ha_data_sharing consent — otherwise the row still lists the property but
// leaves the usage columns blank, exactly like "Not shared" in the UI.
portfolioRouter.get(
  '/export.csv',
  requireOrgSession,
  asyncHandler(async (req, res) => {
    const organizationId = req.org!.organizationId;
    const range = String(req.query.range ?? 'month');
    if (!DASHBOARD_RANGES.includes(range as DashboardRange)) {
      res.status(400).json({ error: `range must be one of: ${DASHBOARD_RANGES.join(', ')}` });
      return;
    }

    const { rows: propertyRows } = await pool.query<PropertyRow>(
      `SELECT p.id, p.address, p.postcode, p.tenant_name, p.connection_date,
              p.fox_access_token IS NOT NULL AS has_fox_token,
              p.tenant_email IS NOT NULL AS has_tenant_email,
              (SELECT MAX(reading_time) FROM meter_readings WHERE property_id = p.id) AS last_reading_at,
              (SELECT MAX(date) FROM daily_rollups WHERE property_id = p.id) AS last_rollup_date
       FROM properties p
       WHERE p.organization_id = $1
       ORDER BY p.address`,
      [organizationId]
    );

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

    const header = [
      'Address', 'Postcode', 'Tenant', 'Connection date', 'Status', 'Data shared',
      'Solar kWh', 'Battery kWh', 'Grid kWh',
      'Bill at grid price only (GBP)', 'Actual bill (GBP)', 'Saving (GBP)',
    ];
    const lines = [header.map(csvField).join(',')];

    for (const p of propertyRows) {
      const { status } = computePropertyStatus({
        hasFoxToken: p.has_fox_token,
        hasTenantEmail: p.has_tenant_email,
        lastReadingAt: p.last_reading_at,
        lastRollupDate: p.last_rollup_date,
      });
      const shared = sharedPropertyIds.has(p.id);

      let solarKwh = '';
      let batteryKwh = '';
      let gridKwh = '';
      let currentBill = '';
      let newBill = '';
      let saving = '';
      if (shared) {
        const agg = await getAggregateForRange(p.id, range as DashboardRange);
        if (agg.hasData) {
          solarKwh = (agg.solar?.kwh ?? 0).toFixed(2);
          batteryKwh = (agg.battery?.kwh ?? 0).toFixed(2);
          gridKwh = (agg.grid?.kwh ?? 0).toFixed(2);
          currentBill = (agg.currentBill ?? 0).toFixed(2);
          newBill = (agg.newBill ?? 0).toFixed(2);
          saving = (agg.saving ?? 0).toFixed(2);
        }
      }

      lines.push(
        [
          p.address,
          p.postcode ?? '',
          p.tenant_name,
          p.connection_date ? new Date(p.connection_date).toISOString().slice(0, 10) : '',
          STATUS_LABELS[status],
          shared ? 'Yes' : 'No',
          solarKwh,
          batteryKwh,
          gridKwh,
          currentBill,
          newBill,
          saving,
        ]
          .map(csvField)
          .join(',')
      );
    }

    const filename = `portfolio-export-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\r\n'));
  })
);

import { Router } from 'express';
import { pool } from '../db/pool';
import { requireSession } from '../auth/requireSession';
import { asyncHandler } from '../lib/asyncHandler';

export const dashboardRouter = Router();

// Spec §7: four period options. Implemented as trailing windows ending at
// the most recent date with a daily_rollups row for this property (not
// "today", since the nightly rollup only just computed yesterday by the
// time a tenant looks) — consistent behaviour across all four options and
// avoids an always-empty "that day" view right after midnight.
const RANGE_DAYS: Record<string, number> = {
  day: 1,
  week: 7,
  '4weeks': 28,
  annual: 365,
};

interface RollupRow {
  date: string;
  solar_self_consumed_kwh: string;
  battery_covered_kwh: string;
  grid_covered_kwh: string;
  estimated_cost_current_bill: string;
  estimated_cost_new_bill: string;
  grid_cap_rate_p_per_kwh: string;
  offpeak_rate_p_per_kwh: string;
}

dashboardRouter.get(
  '/dashboard',
  requireSession,
  asyncHandler(async (req, res) => {
    const propertyId = req.propertyId as number;
    const range = String(req.query.range ?? '4weeks');
    const days = RANGE_DAYS[range];
    if (!days) {
      res.status(400).json({ error: `range must be one of: ${Object.keys(RANGE_DAYS).join(', ')}` });
      return;
    }

    const { rows: latestRows } = await pool.query('SELECT MAX(date) AS latest FROM daily_rollups WHERE property_id = $1', [
      propertyId,
    ]);
    const latest = latestRows[0]?.latest;
    if (!latest) {
      res.json({ range, hasData: false });
      return;
    }

    const { rows } = await pool.query<RollupRow>(
      `SELECT dr.date, dr.solar_self_consumed_kwh, dr.battery_covered_kwh, dr.grid_covered_kwh,
              dr.estimated_cost_current_bill, dr.estimated_cost_new_bill,
              tr.grid_cap_rate_p_per_kwh, tr.offpeak_rate_p_per_kwh
       FROM daily_rollups dr
       JOIN LATERAL (
         SELECT grid_cap_rate_p_per_kwh, offpeak_rate_p_per_kwh
         FROM tariff_rates WHERE effective_from <= dr.date
         ORDER BY effective_from DESC LIMIT 1
       ) tr ON true
       WHERE dr.property_id = $1
         AND dr.date > $2::date - ($3::text || ' days')::interval
         AND dr.date <= $2::date
       ORDER BY dr.date`,
      [propertyId, latest, days]
    );

    let solarKwh = 0;
    let batteryKwh = 0;
    let gridKwh = 0;
    let solarAmount = 0;
    let batteryAmount = 0;
    let gridAmount = 0;
    let currentBill = 0;
    let newBill = 0;

    for (const r of rows) {
      const capRate = Number(r.grid_cap_rate_p_per_kwh) / 100;
      const offpeakRate = Number(r.offpeak_rate_p_per_kwh) / 100;
      solarKwh += Number(r.solar_self_consumed_kwh);
      batteryKwh += Number(r.battery_covered_kwh);
      gridKwh += Number(r.grid_covered_kwh);
      solarAmount += Number(r.solar_self_consumed_kwh) * capRate;
      batteryAmount += Number(r.battery_covered_kwh) * offpeakRate;
      gridAmount += Number(r.grid_covered_kwh) * capRate;
      currentBill += Number(r.estimated_cost_current_bill);
      newBill += Number(r.estimated_cost_new_bill);
    }

    const saving = currentBill - newBill;
    const savingPct = currentBill > 0 ? (saving / currentBill) * 100 : 0;
    const consumption = solarKwh + batteryKwh + gridKwh;

    res.json({
      range,
      hasData: true,
      periodStart: rows[0]?.date ?? latest,
      periodEnd: latest,
      days: rows.length,
      currentBill,
      newBill,
      saving,
      savingPct,
      solar: { kwh: solarKwh, amount: solarAmount, sharePct: consumption > 0 ? (solarKwh / consumption) * 100 : 0 },
      battery: { kwh: batteryKwh, amount: batteryAmount, sharePct: consumption > 0 ? (batteryKwh / consumption) * 100 : 0 },
      grid: { kwh: gridKwh, amount: gridAmount, sharePct: consumption > 0 ? (gridKwh / consumption) * 100 : 0 },
    });
  })
);

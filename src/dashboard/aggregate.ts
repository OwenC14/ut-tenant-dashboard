import { pool } from '../db/pool';

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

export interface PropertyAggregate {
  hasData: boolean;
  periodStart?: string;
  periodEnd?: string;
  days?: number;
  currentBill?: number;
  newBill?: number;
  saving?: number;
  savingPct?: number;
  solar?: { kwh: number; amount: number; sharePct: number };
  battery?: { kwh: number; amount: number; sharePct: number };
  grid?: { kwh: number; amount: number; sharePct: number };
}

// Shared by the tenant dashboard (src/routes/dashboard.ts) and the HA/LA
// drill-down endpoint (src/routes/portfolio.ts) — same trailing-window
// aggregation, same £ breakdown recomputed from tariff_rates at query time.
export async function getPropertyAggregate(propertyId: number, days: number): Promise<PropertyAggregate> {
  const { rows: latestRows } = await pool.query('SELECT MAX(date) AS latest FROM daily_rollups WHERE property_id = $1', [
    propertyId,
  ]);
  const latest = latestRows[0]?.latest;
  if (!latest) {
    return { hasData: false };
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
  const consumption = solarKwh + batteryKwh + gridKwh;

  return {
    hasData: true,
    periodStart: rows[0]?.date ?? latest,
    periodEnd: latest,
    days: rows.length,
    currentBill,
    newBill,
    saving,
    savingPct: currentBill > 0 ? (saving / currentBill) * 100 : 0,
    solar: { kwh: solarKwh, amount: solarAmount, sharePct: consumption > 0 ? (solarKwh / consumption) * 100 : 0 },
    battery: { kwh: batteryKwh, amount: batteryAmount, sharePct: consumption > 0 ? (batteryKwh / consumption) * 100 : 0 },
    grid: { kwh: gridKwh, amount: gridAmount, sharePct: consumption > 0 ? (gridKwh / consumption) * 100 : 0 },
  };
}

import { pool } from '../db/pool';

// Trailing-window lengths for the daily-granularity ranges. '24h' isn't here
// -- it's hourly, handled by getHourlyAggregate below.
export const RANGE_DAYS: Record<'week' | 'month' | 'year', number> = { week: 7, month: 28, year: 365 };
export type DashboardRange = '24h' | 'week' | 'month' | 'year';
export const DASHBOARD_RANGES: DashboardRange[] = ['24h', 'week', 'month', 'year'];

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
  // Daily "with vs without Phase 1" for the comparison graph (public/chart.js)
  // — without/with are that day's (or, for '24h', that hour's) grid-only vs actual bill.
  series?: { date: string; without: number; with: number }[];
  // Only meaningful when aggregating multiple properties (portfolio-wide '24h' view).
  propertiesWithData?: number;
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
    series: rows.map((r) => ({
      date: r.date,
      without: Number(r.estimated_cost_current_bill),
      with: Number(r.estimated_cost_new_bill),
    })),
  };
}

interface HourlyReadingRow {
  property_id: number;
  reading_time: string;
  generation_kwh: string;
  feedin_kwh: string;
  grid_import_kwh: string;
  battery_discharge_kwh: string;
  loads_kwh: string;
}

interface TariffRateRow {
  effective_from: string;
  grid_cap_rate_p_per_kwh: string;
  offpeak_rate_p_per_kwh: string;
}

async function loadTariffRates(): Promise<TariffRateRow[]> {
  const { rows } = await pool.query<TariffRateRow>(
    'SELECT effective_from, grid_cap_rate_p_per_kwh, offpeak_rate_p_per_kwh FROM tariff_rates ORDER BY effective_from ASC'
  );
  // pg returns `date` columns as JS Date objects -- normalize to an ISO
  // date string up front so string comparison against a dayKey (see
  // rateForDay) works correctly instead of comparing Date.toString() output.
  return rows.map((r) => ({ ...r, effective_from: new Date(r.effective_from).toISOString().slice(0, 10) }));
}

function rateForDay(rates: TariffRateRow[], dayKey: string): TariffRateRow | undefined {
  let match: TariffRateRow | undefined;
  for (const r of rates) {
    if (r.effective_from <= dayKey) match = r;
    else break;
  }
  return match;
}

function hourKey(d: Date): string {
  const floored = new Date(d);
  floored.setUTCMinutes(0, 0, 0);
  return floored.toISOString();
}

// The '24 hour view' (spec: hourly breakdown, not just "today"). Unlike
// daily_rollups, meter_readings are cumulative-for-the-day snapshots (see
// src/jobs/poll.ts) that reset to zero at midnight -- diffing across a day
// boundary would double count, so the first reading of each calendar day is
// treated as its own increment rather than diffed against the previous day's
// last reading. Standing charge is deliberately left out of the hourly
// without/with figures (arbitrarily attributing 1/24 of a fixed daily charge
// to a given hour would be misleading); it only affects the daily/weekly/
// annual bill totals above.
//
// Takes an array of property IDs so the same function serves both a single
// tenant's dashboard and a whole HA portfolio's 24-hour view.
export async function getHourlyAggregate(propertyIds: number[], hours = 24): Promise<PropertyAggregate> {
  if (propertyIds.length === 0) return { hasData: false };

  const { rows: latestRows } = await pool.query(
    'SELECT MAX(reading_time) AS latest FROM meter_readings WHERE property_id = ANY($1::bigint[])',
    [propertyIds]
  );
  const latest = latestRows[0]?.latest;
  if (!latest) return { hasData: false };

  const rates = await loadTariffRates();
  if (rates.length === 0) return { hasData: false };

  const latestBucket = new Date(hourKey(new Date(latest)));
  const windowStart = new Date(latestBucket.getTime() - (hours - 1) * 3600_000);
  // Fetch from the start of the calendar day the window begins in, so the
  // first reading inside the window can still be diffed against its
  // same-day predecessor rather than looking like a fresh-day baseline.
  const fetchFrom = new Date(windowStart);
  fetchFrom.setUTCHours(0, 0, 0, 0);

  const { rows } = await pool.query<HourlyReadingRow>(
    `SELECT property_id, reading_time, generation_kwh, feedin_kwh, grid_import_kwh, battery_discharge_kwh, loads_kwh
     FROM meter_readings
     WHERE property_id = ANY($1::bigint[]) AND reading_time >= $2 AND reading_time <= $3
     ORDER BY property_id, reading_time ASC`,
    [propertyIds, fetchFrom.toISOString(), latest]
  );

  const buckets = new Map<string, { without: number; with: number }>();
  const prevByProperty = new Map<
    number,
    { dayKey: string; generation: number; feedin: number; grid: number; battery: number; loads: number }
  >();
  const propertiesWithData = new Set<number>();

  let solarKwh = 0;
  let batteryKwh = 0;
  let gridKwh = 0;
  let solarAmount = 0;
  let batteryAmount = 0;
  let gridAmount = 0;
  let currentBill = 0;
  let newBill = 0;

  for (const r of rows) {
    const t = new Date(r.reading_time);
    const dayKey = t.toISOString().slice(0, 10);
    const generation = Number(r.generation_kwh);
    const feedin = Number(r.feedin_kwh);
    const grid = Number(r.grid_import_kwh);
    const battery = Number(r.battery_discharge_kwh);
    const loads = Number(r.loads_kwh);

    const prev = prevByProperty.get(r.property_id);
    const sameDay = prev?.dayKey === dayKey;
    const dGeneration = sameDay ? generation - prev!.generation : generation;
    const dFeedin = sameDay ? feedin - prev!.feedin : feedin;
    const dGrid = sameDay ? grid - prev!.grid : grid;
    const dBattery = sameDay ? battery - prev!.battery : battery;
    const dLoads = sameDay ? loads - prev!.loads : loads;
    prevByProperty.set(r.property_id, { dayKey, generation, feedin, grid, battery, loads });

    const bucketTime = new Date(hourKey(t));
    if (bucketTime < windowStart || bucketTime > latestBucket) continue;

    const rate = rateForDay(rates, dayKey);
    if (!rate) continue;
    const capRate = Number(rate.grid_cap_rate_p_per_kwh) / 100;
    const offpeakRate = Number(rate.offpeak_rate_p_per_kwh) / 100;

    // Clamp negative increments (a possible meter/API glitch, not a real
    // negative usage) to zero rather than letting one bad reading corrupt a bucket.
    const solarSelfConsumed = Math.max(0, dGeneration - dFeedin);
    const batteryCovered = Math.max(0, dBattery);
    const gridCovered = Math.max(0, dGrid);
    const consumption = Math.max(0, dLoads);

    const without = consumption * capRate;
    const withCost = batteryCovered * offpeakRate + gridCovered * capRate;

    propertiesWithData.add(r.property_id);
    solarKwh += solarSelfConsumed;
    batteryKwh += batteryCovered;
    gridKwh += gridCovered;
    solarAmount += solarSelfConsumed * capRate;
    batteryAmount += batteryCovered * offpeakRate;
    gridAmount += gridCovered * capRate;
    currentBill += without;
    newBill += withCost;

    const key = bucketTime.toISOString();
    const bucket = buckets.get(key) ?? { without: 0, with: 0 };
    bucket.without += without;
    bucket.with += withCost;
    buckets.set(key, bucket);
  }

  const bucketKeys = [...buckets.keys()].sort();
  const saving = currentBill - newBill;
  const consumption = solarKwh + batteryKwh + gridKwh;

  return {
    hasData: bucketKeys.length > 0,
    periodStart: bucketKeys[0],
    periodEnd: bucketKeys[bucketKeys.length - 1],
    days: bucketKeys.length,
    currentBill,
    newBill,
    saving,
    savingPct: currentBill > 0 ? (saving / currentBill) * 100 : 0,
    solar: { kwh: solarKwh, amount: solarAmount, sharePct: consumption > 0 ? (solarKwh / consumption) * 100 : 0 },
    battery: { kwh: batteryKwh, amount: batteryAmount, sharePct: consumption > 0 ? (batteryKwh / consumption) * 100 : 0 },
    grid: { kwh: gridKwh, amount: gridAmount, sharePct: consumption > 0 ? (gridKwh / consumption) * 100 : 0 },
    series: bucketKeys.map((k) => ({ date: k, without: buckets.get(k)!.without, with: buckets.get(k)!.with })),
    propertiesWithData: propertiesWithData.size,
  };
}

// Single-property convenience wrapper used by the tenant dashboard and the
// HA/LA per-property drill-down — resolves the four range options (spec:
// "1 Year view, Month view, Week view, 24 hour view") to the right
// aggregation function.
export async function getAggregateForRange(propertyId: number, range: DashboardRange): Promise<PropertyAggregate> {
  if (range === '24h') {
    return getHourlyAggregate([propertyId], 24);
  }
  return getPropertyAggregate(propertyId, RANGE_DAYS[range]);
}

import { pool } from '../db/pool';

// Cost formulas mirror UT_Phase1_Tenant_Calculator.html's render() exactly
// (docs/UT_Phase1_Tenant_Calculator.html lines ~588-598), just fed the real
// solar/battery/grid split from meter_readings instead of a slider-derived
// estimate, and per-day instead of annualised.
interface TariffRate {
  grid_cap_rate_p_per_kwh: string;
  offpeak_rate_p_per_kwh: string;
  standing_charge_p_per_day: string;
}

function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function getTariffRate(date: string): Promise<TariffRate> {
  const { rows } = await pool.query<TariffRate>(
    `SELECT grid_cap_rate_p_per_kwh, offpeak_rate_p_per_kwh, standing_charge_p_per_day
     FROM tariff_rates
     WHERE effective_from <= $1
     ORDER BY effective_from DESC
     LIMIT 1`,
    [date]
  );
  if (rows.length === 0) {
    throw new Error(`No tariff_rates row with effective_from <= ${date} — seed at least one rate`);
  }
  return rows[0];
}

async function run() {
  // Optional YYYY-MM-DD arg for reprocessing a specific day; defaults to
  // yesterday (UTC) since this runs nightly.
  const date = process.argv[2] ?? yesterdayUTC();
  const rate = await getTariffRate(date);
  const capRate = Number(rate.grid_cap_rate_p_per_kwh) / 100;
  const offpeakRate = Number(rate.offpeak_rate_p_per_kwh) / 100;
  const standingChargeDaily = Number(rate.standing_charge_p_per_day) / 100;

  // meter_readings rows are cumulative-for-the-day snapshots (see
  // src/jobs/poll.ts) — the last reading before the day rolls over holds
  // that day's totals.
  const { rows: readings } = await pool.query(
    `SELECT DISTINCT ON (property_id) property_id, generation_kwh, feedin_kwh,
            grid_import_kwh, battery_discharge_kwh, loads_kwh
     FROM meter_readings
     WHERE reading_time >= $1::date AND reading_time < ($1::date + interval '1 day')
     ORDER BY property_id, reading_time DESC`,
    [date]
  );

  console.log(`Rolling up ${readings.length} propert${readings.length === 1 ? 'y' : 'ies'} for ${date}`);

  for (const r of readings) {
    const solarSelfConsumed = Number(r.generation_kwh) - Number(r.feedin_kwh);
    const batteryCovered = Number(r.battery_discharge_kwh);
    const gridCovered = Number(r.grid_import_kwh);
    const consumption = Number(r.loads_kwh);

    const currentBill = consumption * capRate + standingChargeDaily;
    const newBill = batteryCovered * offpeakRate + gridCovered * capRate + standingChargeDaily;
    const saving = currentBill - newBill;

    await pool.query(
      `INSERT INTO daily_rollups
         (property_id, date, solar_self_consumed_kwh, battery_covered_kwh, grid_covered_kwh,
          estimated_cost_current_bill, estimated_cost_new_bill, estimated_saving)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (property_id, date) DO UPDATE SET
         solar_self_consumed_kwh = EXCLUDED.solar_self_consumed_kwh,
         battery_covered_kwh = EXCLUDED.battery_covered_kwh,
         grid_covered_kwh = EXCLUDED.grid_covered_kwh,
         estimated_cost_current_bill = EXCLUDED.estimated_cost_current_bill,
         estimated_cost_new_bill = EXCLUDED.estimated_cost_new_bill,
         estimated_saving = EXCLUDED.estimated_saving`,
      [r.property_id, date, solarSelfConsumed, batteryCovered, gridCovered, currentBill, newBill, saving]
    );
  }

  console.log('Rollup complete.');
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

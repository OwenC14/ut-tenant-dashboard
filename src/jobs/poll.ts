import { pool } from '../db/pool';
import { queryDeviceReport } from '../fox/reportClient';
import { decrypt } from '../lib/crypto';

// §4.2 sanity check: loads should roughly equal solar self-consumed + battery
// discharge + grid consumption. A mismatch beyond this tolerance usually means
// a meter/CT clamp misconfiguration, not real usage — log and flag, don't fail.
const RECONCILE_TOLERANCE_KWH = 0.5;

interface PollableProperty {
  id: number;
  fox_device_sn: string;
  fox_access_token: string;
}

async function pollProperty(property: PollableProperty): Promise<void> {
  const accessToken = decrypt(property.fox_access_token);
  const totals = await queryDeviceReport(accessToken, property.fox_device_sn, new Date());

  const solarSelfConsumed = totals.generation - totals.feedin;
  const reconciledLoads = solarSelfConsumed + totals.dischargeEnergyToTal + totals.gridConsumption;
  const diff = Math.abs(reconciledLoads - totals.loads);
  if (diff > RECONCILE_TOLERANCE_KWH) {
    console.warn(
      `[reconciliation] property ${property.id}: loads=${totals.loads.toFixed(2)}kWh vs ` +
        `solar+battery+grid=${reconciledLoads.toFixed(2)}kWh (diff ${diff.toFixed(2)}kWh) — check meter/CT clamp config`
    );
  }

  await pool.query(
    `INSERT INTO meter_readings
       (property_id, reading_time, generation_kwh, feedin_kwh, grid_import_kwh,
        battery_charge_kwh, battery_discharge_kwh, loads_kwh, raw_response)
     VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8)`,
    [
      property.id,
      totals.generation,
      totals.feedin,
      totals.gridConsumption,
      totals.chargeEnergyToTal,
      totals.dischargeEnergyToTal,
      totals.loads,
      JSON.stringify(totals),
    ]
  );
}

async function run() {
  const { rows } = await pool.query<PollableProperty>(
    `SELECT id, fox_device_sn, fox_access_token
     FROM properties
     WHERE fox_access_token IS NOT NULL AND fox_device_sn IS NOT NULL`
  );

  console.log(`Polling ${rows.length} propert${rows.length === 1 ? 'y' : 'ies'}`);

  // Sequential and lightly throttled to respect Fox's 1 req/sec cap (§4.3) —
  // fine at pilot scale (≤200 devices, §2); revisit with a job queue at 20k.
  for (const row of rows) {
    try {
      await pollProperty(row);
      console.log(`Polled property ${row.id}`);
    } catch (err) {
      console.error(`Failed to poll property ${row.id}:`, err);
    }
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

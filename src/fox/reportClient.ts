import { createHash } from 'crypto';
import { env } from '../config/env';

const REPORT_PATH = '/op/v0/device/report/query';

export const REPORT_VARIABLES = [
  'generation',
  'loads',
  'feedin',
  'gridConsumption',
  'chargeEnergyToTal',
  'dischargeEnergyToTal',
] as const;

export type ReportVariable = (typeof REPORT_VARIABLES)[number];

interface ReportSeriesPoint {
  time: string;
  value: number;
}

interface ReportSeries {
  variable: string;
  unit: string;
  data: ReportSeriesPoint[];
}

interface ReportResult {
  deviceSN: string;
  datas: ReportSeries[];
}

function signRequest(path: string, accessToken: string, timestamp: number): string {
  return createHash('md5').update(`${path}\r\n${accessToken}\r\n${timestamp}`).digest('hex');
}

// Fox's OAuth-mode signing scheme (spec §4.1/§4.3): the private-key `token`
// header is dropped in favour of the OAuth Authorization header, but the
// request is still signed using the access token in place of the private key.
//
// Fox's "day" dimension is documented to return per-hour datapoints, but the
// public docs don't confirm whether each point is an hourly increment or a
// running cumulative total. This treats them as increments and sums the
// elapsed hours to get "today's total so far" — confirm against a real
// device response and adjust here (only) if that's wrong.
export async function queryDeviceReport(
  accessToken: string,
  deviceSN: string,
  date: Date
): Promise<Record<ReportVariable, number>> {
  const timestamp = Date.now();
  const signature = signRequest(REPORT_PATH, accessToken, timestamp);
  const url = new URL(REPORT_PATH, env.FOX_DOMAIN);

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      signature,
      timestamp: String(timestamp),
      lang: 'en',
    },
    body: JSON.stringify({
      sn: deviceSN,
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      dimension: 'day',
      variables: REPORT_VARIABLES,
    }),
  });

  const text = await res.text();
  let body: { errno?: number; result?: ReportResult[] };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Fox report query returned non-JSON response (status ${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok || body.errno) {
    throw new Error(`Fox report query failed (status ${res.status}, errno ${body.errno}): ${text.slice(0, 200)}`);
  }

  const series = body.result?.[0]?.datas ?? [];
  const totals: Partial<Record<ReportVariable, number>> = {};
  for (const variable of REPORT_VARIABLES) {
    const points = series.find((s) => s.variable === variable)?.data ?? [];
    totals[variable] = points.reduce((sum, p) => sum + (p.value ?? 0), 0);
  }

  return totals as Record<ReportVariable, number>;
}

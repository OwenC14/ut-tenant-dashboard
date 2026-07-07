// Real onboarding/health status per property, replacing the earlier boolean
// `flagged` with something that can actually tell an HA/admin user what to
// do next, not just that something's wrong.
export type PropertyStatus = 'not_connected' | 'no_tenant' | 'awaiting_data' | 'disconnected' | 'ok';

export const STALE_READING_HOURS = 48;
export const STALE_ROLLUP_DAYS = 2;

export interface PropertyStatusInput {
  hasFoxToken: boolean;
  hasTenantEmail: boolean;
  lastReadingAt: string | Date | null;
  lastRollupDate: string | Date | null;
}

export interface PropertyStatusResult {
  status: PropertyStatus;
  requiredActions: string[];
}

export function computePropertyStatus(p: PropertyStatusInput): PropertyStatusResult {
  if (!p.hasFoxToken) {
    return {
      status: 'not_connected',
      requiredActions: ["Send the tenant the Fox consent link so they can link their inverter (Admin → Fox consent link)."],
    };
  }
  if (!p.hasTenantEmail) {
    return {
      status: 'no_tenant',
      requiredActions: ["Give the tenant their signup code, or set their email directly, so they can access their dashboard."],
    };
  }

  const now = Date.now();
  const lastReadingAgeHours = p.lastReadingAt ? (now - new Date(p.lastReadingAt).getTime()) / (1000 * 60 * 60) : Infinity;
  const lastRollupAgeDays = p.lastRollupDate ? (now - new Date(p.lastRollupDate).getTime()) / (1000 * 60 * 60 * 24) : Infinity;

  if (!p.lastReadingAt) {
    return {
      status: 'awaiting_data',
      requiredActions: ['Waiting for the first poll — check back after the next 15-minute cycle.'],
    };
  }
  if (lastReadingAgeHours > STALE_READING_HOURS || lastRollupAgeDays > STALE_ROLLUP_DAYS) {
    return {
      status: 'disconnected',
      requiredActions: [
        `No readings in over ${STALE_READING_HOURS} hours — check the Fox device is online and the tenant's Fox account authorization hasn't been revoked.`,
      ],
    };
  }

  return { status: 'ok', requiredActions: [] };
}

export const STATUS_LABELS: Record<PropertyStatus, string> = {
  not_connected: 'Not connected',
  no_tenant: 'No tenant account',
  awaiting_data: 'Awaiting first data',
  disconnected: 'Disconnected',
  ok: 'OK',
};

import { Router } from 'express';
import { requireSession } from '../auth/requireSession';
import { requireAppTermsAccepted } from '../auth/requireAppTerms';
import { asyncHandler } from '../lib/asyncHandler';
import { getPropertyAggregate } from '../dashboard/aggregate';

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

dashboardRouter.get(
  '/dashboard',
  requireSession,
  requireAppTermsAccepted,
  asyncHandler(async (req, res) => {
    const propertyId = req.propertyId as number;
    const range = String(req.query.range ?? '4weeks');
    const days = RANGE_DAYS[range];
    if (!days) {
      res.status(400).json({ error: `range must be one of: ${Object.keys(RANGE_DAYS).join(', ')}` });
      return;
    }

    const aggregate = await getPropertyAggregate(propertyId, days);
    res.json({ range, ...aggregate });
  })
);

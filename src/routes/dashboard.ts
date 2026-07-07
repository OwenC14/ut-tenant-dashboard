import { Router } from 'express';
import { requireSession } from '../auth/requireSession';
import { requireAppTermsAccepted } from '../auth/requireAppTerms';
import { asyncHandler } from '../lib/asyncHandler';
import { getAggregateForRange, DASHBOARD_RANGES, DashboardRange } from '../dashboard/aggregate';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/dashboard',
  requireSession,
  requireAppTermsAccepted,
  asyncHandler(async (req, res) => {
    const propertyId = req.propertyId as number;
    const range = String(req.query.range ?? 'month');
    if (!DASHBOARD_RANGES.includes(range as DashboardRange)) {
      res.status(400).json({ error: `range must be one of: ${DASHBOARD_RANGES.join(', ')}` });
      return;
    }

    // Trailing windows ending at the most recent data point for this
    // property (not "today"/"this hour") -- consistent across all four
    // options and avoids an always-empty view right after midnight or
    // between polls.
    const aggregate = await getAggregateForRange(propertyId, range as DashboardRange);
    res.json({ range, granularity: range === '24h' ? 'hour' : 'day', ...aggregate });
  })
);

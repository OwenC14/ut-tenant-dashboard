import { RequestHandler } from 'express';
import { getCurrentConsentStatus } from '../consent/agreements';
import { asyncHandler } from '../lib/asyncHandler';

// Spec §9a.4 flow point 1: app_terms gates the dashboard outright. Unlike
// ha_data_sharing, there's no "declined" path here -- accept to continue.
export const requireAppTermsAccepted: RequestHandler = asyncHandler(async (req, res, next) => {
  const propertyId = req.propertyId as number;
  const status = await getCurrentConsentStatus(propertyId, 'app_terms');
  if (!status || status.status !== 'accepted') {
    res.status(403).json({ error: 'app_terms_not_accepted', agreementId: status?.agreementId ?? null });
    return;
  }
  next();
});

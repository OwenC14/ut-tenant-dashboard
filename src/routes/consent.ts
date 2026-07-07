import { Router } from 'express';
import { requireSession } from '../auth/requireSession';
import { asyncHandler } from '../lib/asyncHandler';
import { getCurrentAgreement, getCurrentConsentStatus, recordConsent, AgreementType, ConsentDecision } from '../consent/agreements';

export const consentRouter = Router();
consentRouter.use(requireSession);

const TYPES: AgreementType[] = ['app_terms', 'ha_data_sharing'];

consentRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    const propertyId = req.propertyId as number;
    const [appTerms, haDataSharing] = await Promise.all([
      getCurrentConsentStatus(propertyId, 'app_terms'),
      getCurrentConsentStatus(propertyId, 'ha_data_sharing'),
    ]);
    res.json({ appTerms, haDataSharing });
  })
);

consentRouter.post(
  '/:type',
  asyncHandler(async (req, res) => {
    const propertyId = req.propertyId as number;
    const type = req.params.type as AgreementType;
    const status = req.body?.status as ConsentDecision;

    if (!TYPES.includes(type)) {
      res.status(400).json({ error: `type must be one of: ${TYPES.join(', ')}` });
      return;
    }
    // app_terms has no decline/withdraw path (spec §9a.4 point 1) -- it's an
    // accept-to-continue gate, unlike ha_data_sharing (point 2).
    const allowedStatuses: ConsentDecision[] = type === 'app_terms' ? ['accepted'] : ['accepted', 'declined', 'withdrawn'];
    if (!allowedStatuses.includes(status)) {
      res.status(400).json({ error: `status must be one of: ${allowedStatuses.join(', ')}` });
      return;
    }

    const agreement = await getCurrentAgreement(type);
    if (!agreement) {
      res.status(500).json({ error: `no current ${type} agreement configured` });
      return;
    }

    await recordConsent(propertyId, agreement.id, status, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ status: 'ok' });
  })
);

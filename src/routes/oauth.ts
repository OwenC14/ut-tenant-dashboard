import { Router } from 'express';
import { pool } from '../db/pool';
import { buildAuthorizeUrl, exchangeCodeForTokens } from '../fox/client';
import { createState, consumeState } from '../oauth/stateStore';
import { encrypt } from '../lib/crypto';
import { asyncHandler } from '../lib/asyncHandler';

export const oauthRouter = Router();

oauthRouter.get(
  '/fox/authorize',
  asyncHandler(async (req, res) => {
    const propertyId = Number(req.query.propertyId);
    if (!Number.isInteger(propertyId)) {
      res.status(400).json({ error: 'propertyId query param is required' });
      return;
    }

    const { rows } = await pool.query('SELECT id FROM properties WHERE id = $1', [propertyId]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'property not found' });
      return;
    }

    const state = createState(propertyId);
    res.redirect(buildAuthorizeUrl(state));
  })
);

oauthRouter.get(
  '/fox/callback',
  asyncHandler(async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;

    if (error) {
      res.status(400).json({ error: `Fox consent declined or failed: ${error}` });
      return;
    }
    if (!code || !state) {
      res.status(400).json({ error: 'code and state query params are required' });
      return;
    }

    const propertyId = consumeState(state);
    if (propertyId === null) {
      res.status(400).json({ error: 'invalid or expired state' });
      return;
    }

    const tokens = await exchangeCodeForTokens(code);

    // connection_date is set once, the first time linking succeeds -- a
    // refresh (step §4.1 point 5) re-runs this callback path's cousin in
    // refresh-tokens.ts, not this one, so COALESCE here is defence in depth
    // rather than the primary guard against overwriting it.
    await pool.query(
      `UPDATE properties
       SET fox_access_token = $1,
           fox_refresh_token = $2,
           fox_token_expires_at = $3,
           connection_date = COALESCE(connection_date, CURRENT_DATE)
       WHERE id = $4`,
      [encrypt(tokens.accessToken), encrypt(tokens.refreshToken), tokens.expiresAt, propertyId]
    );

    res.json({ status: 'ok', message: 'Fox account linked', propertyId });
  })
);

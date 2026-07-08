import { Router } from 'express';
import { pool } from '../db/pool';
import { createMagicLink, consumeMagicLink, createSession } from '../auth/session';
import { sendMagicLinkEmail } from '../lib/mailer';
import { asyncHandler } from '../lib/asyncHandler';
import { isUniqueViolation } from '../lib/db';
import { env } from '../config/env';
import { getCurrentAgreement, getCurrentConsentStatus, recordConsent } from '../consent/agreements';

export const authRouter = Router();

const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Tenant self-signup: claims an already-onboarded-but-unclaimed property
// using the installer-given code, then immediately sends a login link so
// signup and first login are one continuous flow. No rate limiting yet on
// this endpoint — the code space (33M combinations) resists casual guessing
// but this is a real gap to close before go-live (see README).
authRouter.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const code = String(req.body?.code ?? '')
      .trim()
      .toUpperCase();
    const email = String(req.body?.email ?? '')
      .trim()
      .toLowerCase();
    if (!code || !email) {
      res.status(400).json({ error: 'code and email are required' });
      return;
    }

    const { rows } = await pool.query('SELECT id, tenant_email FROM properties WHERE signup_code = $1', [code]);
    if (rows.length === 0) {
      res.status(400).json({ error: 'invalid_code', message: "We couldn't find a property with that installation reference." });
      return;
    }
    if (rows[0].tenant_email !== null) {
      res.status(409).json({ error: 'already_claimed', message: 'This property already has an account. Try signing in instead.' });
      return;
    }

    const propertyId = rows[0].id;
    try {
      await pool.query('UPDATE properties SET tenant_email = $1 WHERE id = $2', [email, propertyId]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'email_in_use', message: 'That email is already registered to a different property.' });
        return;
      }
      throw err;
    }

    const token = await createMagicLink(propertyId, email);
    const link = new URL(`/auth/verify?token=${token}`, env.APP_BASE_URL).toString();
    await sendMagicLinkEmail(email, link);

    res.json({ status: 'ok', message: 'Account created — check your email for a login link.' });
  })
);

authRouter.post(
  '/magic-link',
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email ?? '')
      .trim()
      .toLowerCase();
    if (!email) {
      res.status(400).json({ error: 'email is required' });
      return;
    }

    const { rows } = await pool.query('SELECT id FROM properties WHERE tenant_email = $1', [email]);

    // Same response whether or not the email matches a property, so this
    // endpoint can't be used to enumerate which emails are onboarded.
    if (rows.length > 0) {
      const token = await createMagicLink(rows[0].id, email);
      const link = new URL(`/auth/verify?token=${token}`, env.APP_BASE_URL).toString();
      await sendMagicLinkEmail(email, link);
    }

    res.json({ status: 'ok', message: 'If that email is registered, a login link has been sent.' });
  })
);

authRouter.get(
  '/verify',
  asyncHandler(async (req, res) => {
    const token = String(req.query.token ?? '');
    const propertyId = await consumeMagicLink(token);
    if (propertyId === null) {
      res.status(400).send('This login link is invalid or has expired. Request a new one.');
      return;
    }

    const sessionToken = await createSession(propertyId);
    res.cookie('session', sessionToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
    });

    // Tenant Interface spec: signing in itself carries the ha_data_sharing
    // notice ("by signing in, you agree to share your data and can opt out")
    // rather than a separate accept/decline banner shown afterward. Only
    // fires when this property has never decided for the CURRENT agreement
    // version -- an explicit withdraw/decline already on record is never
    // silently overwritten, and a version bump naturally re-applies this
    // once (status resets to null for the new version, same as before).
    const haAgreement = await getCurrentAgreement('ha_data_sharing');
    if (haAgreement) {
      const consent = await getCurrentConsentStatus(propertyId, 'ha_data_sharing');
      if (consent && consent.status === null) {
        await recordConsent(propertyId, haAgreement.id, 'accepted', { recordedBy: 'implied_at_signin' });
      }
    }

    res.redirect('/dashboard.html');
  })
);

authRouter.post('/logout', (_req, res) => {
  res.clearCookie('session');
  res.json({ status: 'ok' });
});

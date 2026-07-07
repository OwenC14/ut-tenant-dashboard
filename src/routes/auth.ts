import { Router } from 'express';
import { pool } from '../db/pool';
import { createMagicLink, consumeMagicLink, createSession } from '../auth/session';
import { sendMagicLinkEmail } from '../lib/mailer';
import { asyncHandler } from '../lib/asyncHandler';
import { env } from '../config/env';

export const authRouter = Router();

const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
    res.redirect('/dashboard.html');
  })
);

authRouter.post('/logout', (_req, res) => {
  res.clearCookie('session');
  res.json({ status: 'ok' });
});

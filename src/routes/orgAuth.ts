import { Router } from 'express';
import { pool } from '../db/pool';
import { createOrgMagicLink, consumeOrgMagicLink, createOrgSession } from '../auth/orgSession';
import { sendMagicLinkEmail } from '../lib/mailer';
import { asyncHandler } from '../lib/asyncHandler';
import { env } from '../config/env';

export const orgAuthRouter = Router();

const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

orgAuthRouter.post(
  '/magic-link',
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email ?? '')
      .trim()
      .toLowerCase();
    if (!email) {
      res.status(400).json({ error: 'email is required' });
      return;
    }

    const { rows } = await pool.query('SELECT id FROM organization_users WHERE email = $1', [email]);

    // Same response either way — no enumeration of which emails are onboarded.
    if (rows.length > 0) {
      const token = await createOrgMagicLink(rows[0].id, email);
      const link = new URL(`/org-auth/verify?token=${token}`, env.APP_BASE_URL).toString();
      await sendMagicLinkEmail(email, link);
    }

    res.json({ status: 'ok', message: 'If that email is registered, a login link has been sent.' });
  })
);

orgAuthRouter.get(
  '/verify',
  asyncHandler(async (req, res) => {
    const token = String(req.query.token ?? '');
    const organizationUserId = await consumeOrgMagicLink(token);
    if (organizationUserId === null) {
      res.status(400).send('This login link is invalid or has expired. Request a new one.');
      return;
    }

    const sessionToken = await createOrgSession(organizationUserId);
    res.cookie('org_session', sessionToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
    });
    res.redirect('/portfolio.html');
  })
);

orgAuthRouter.post('/logout', (_req, res) => {
  res.clearCookie('org_session');
  res.json({ status: 'ok' });
});

import { Router } from 'express';
import { pool } from '../db/pool';
import { createAdminMagicLink, consumeAdminMagicLink, createAdminSession } from '../auth/adminSession';
import { sendMagicLinkEmail } from '../lib/mailer';
import { asyncHandler } from '../lib/asyncHandler';
import { env } from '../config/env';

export const adminAuthRouter = Router();

const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

adminAuthRouter.post(
  '/magic-link',
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email ?? '')
      .trim()
      .toLowerCase();
    if (!email) {
      res.status(400).json({ error: 'email is required' });
      return;
    }

    const { rows } = await pool.query('SELECT id FROM admin_users WHERE email = $1', [email]);

    if (rows.length > 0) {
      const token = await createAdminMagicLink(rows[0].id, email);
      const link = new URL(`/admin-auth/verify?token=${token}`, env.APP_BASE_URL).toString();
      await sendMagicLinkEmail(email, link);
    }

    res.json({ status: 'ok', message: 'If that email is registered, a login link has been sent.' });
  })
);

adminAuthRouter.get(
  '/verify',
  asyncHandler(async (req, res) => {
    const token = String(req.query.token ?? '');
    const adminUserId = await consumeAdminMagicLink(token);
    if (adminUserId === null) {
      res.status(400).send('This login link is invalid or has expired. Request a new one.');
      return;
    }

    const sessionToken = await createAdminSession(adminUserId);
    res.cookie('admin_session', sessionToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
    });
    res.redirect('/admin.html');
  })
);

adminAuthRouter.post('/logout', (_req, res) => {
  res.clearCookie('admin_session');
  res.json({ status: 'ok' });
});

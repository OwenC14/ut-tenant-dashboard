import { RequestHandler } from 'express';
import { env } from '../config/env';
import { resolveAdminSession } from './adminSession';

// Two ways in: the shared ADMIN_API_KEY (a break-glass/bootstrap credential —
// see README — always treated as super_admin), or a real admin_users session
// via magic-link login. Either way this only confirms "some admin" — role-
// specific checks (requireSuperAdmin) run after this.
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.headers.authorization === `Bearer ${env.ADMIN_API_KEY}`) {
    req.adminRole = 'super_admin';
    next();
    return;
  }

  const token = req.cookies?.admin_session as string | undefined;
  if (!token) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  resolveAdminSession(token)
    .then((info) => {
      if (!info) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      req.adminUserId = info.adminUserId;
      req.adminRole = info.role;
      next();
    })
    .catch(next);
};

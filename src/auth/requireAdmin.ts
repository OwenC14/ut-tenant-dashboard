import { RequestHandler } from 'express';
import { env } from '../config/env';

// Shared bearer token for internal UT staff, not a full admin user/role system
// — reasonable at pilot scale (≤200 properties, small install team, §2/§3).
// Revisit with real admin accounts before scale-out.
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.headers.authorization !== `Bearer ${env.ADMIN_API_KEY}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
};

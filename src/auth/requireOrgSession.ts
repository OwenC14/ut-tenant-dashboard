import { RequestHandler } from 'express';
import { resolveOrgSession } from './orgSession';

export const requireOrgSession: RequestHandler = (req, res, next) => {
  const token = req.cookies?.org_session as string | undefined;
  if (!token) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }

  resolveOrgSession(token)
    .then((info) => {
      if (info === null) {
        res.status(401).json({ error: 'session expired or invalid' });
        return;
      }
      req.org = info;
      next();
    })
    .catch(next);
};

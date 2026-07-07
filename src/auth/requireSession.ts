import { RequestHandler } from 'express';
import { resolveSession } from './session';

export const requireSession: RequestHandler = (req, res, next) => {
  const token = req.cookies?.session as string | undefined;
  if (!token) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }

  resolveSession(token)
    .then((propertyId) => {
      if (propertyId === null) {
        res.status(401).json({ error: 'session expired or invalid' });
        return;
      }
      req.propertyId = propertyId;
      next();
    })
    .catch(next);
};

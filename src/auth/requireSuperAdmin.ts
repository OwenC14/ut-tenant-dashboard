import { RequestHandler } from 'express';

// Assumes requireAdmin already ran on this router (it has, via
// adminRouter.use(requireAdmin)) and req.adminRole is set.
export const requireSuperAdmin: RequestHandler = (req, res, next) => {
  if (req.adminRole !== 'super_admin') {
    res.status(403).json({ error: 'requires super_admin role' });
    return;
  }
  next();
};

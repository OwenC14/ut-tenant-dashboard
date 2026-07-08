import { RequestHandler } from 'express';
import { pool } from '../db/pool';

// Backend Interface spec: super_admin has all access; operations and
// installer are scoped to whichever clients (organizations) they've been
// assigned in admin_client_assignments. An installer with zero assignments
// is treated as a Union Technical installer and sees every client -- the
// spec's stated exception ("it is not Union Technical, who can see all").
// Operations with zero assignments see nothing yet -- a client has to be
// assigned to them first, there's no equivalent "sees all" default for that
// role.
export type AdminClientScope = 'all' | number[];

export async function resolveAdminClientScope(req: {
  adminRole?: 'super_admin' | 'operations' | 'installer';
  adminUserId?: number;
}): Promise<AdminClientScope> {
  if (req.adminRole === 'super_admin') return 'all';
  if (!req.adminUserId) return [];

  const { rows } = await pool.query('SELECT organization_id FROM admin_client_assignments WHERE admin_user_id = $1', [
    req.adminUserId,
  ]);
  const orgIds = rows.map((r) => Number(r.organization_id));

  if (req.adminRole === 'installer' && orgIds.length === 0) return 'all';
  return orgIds;
}

// Every admin_users row hit by requireAdmin's break-glass ADMIN_API_KEY path
// has no adminUserId and is always treated as super_admin there, so it never
// reaches this guard's 403 branch.
export const blockInstallerWrites: RequestHandler = (req, res, next) => {
  if (req.adminRole === 'installer') {
    res.status(403).json({ error: 'installer accounts are read-only' });
    return;
  }
  next();
};

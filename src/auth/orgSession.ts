import { randomBytes, createHash } from 'crypto';
import { pool } from '../db/pool';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createOrgMagicLink(organizationUserId: number, email: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO org_magic_links (organization_user_id, email, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '15 minutes')`,
    [organizationUserId, email, hashToken(token)]
  );
  return token;
}

export async function consumeOrgMagicLink(token: string): Promise<number | null> {
  const { rows } = await pool.query(
    `UPDATE org_magic_links SET consumed_at = now()
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING organization_user_id`,
    [hashToken(token)]
  );
  return rows[0]?.organization_user_id ?? null;
}

export async function createOrgSession(organizationUserId: number): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO org_sessions (organization_user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '30 days')`,
    [organizationUserId, hashToken(token)]
  );
  return token;
}

export interface OrgSessionInfo {
  organizationUserId: number;
  organizationId: number;
  role: string;
}

export async function resolveOrgSession(token: string): Promise<OrgSessionInfo | null> {
  const { rows } = await pool.query(
    `SELECT ou.id AS organization_user_id, ou.organization_id, ou.role
     FROM org_sessions s
     JOIN organization_users ou ON ou.id = s.organization_user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  if (rows.length === 0) return null;
  return {
    organizationUserId: rows[0].organization_user_id,
    organizationId: rows[0].organization_id,
    role: rows[0].role,
  };
}

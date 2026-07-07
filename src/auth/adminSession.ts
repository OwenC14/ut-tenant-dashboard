import { randomBytes, createHash } from 'crypto';
import { pool } from '../db/pool';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createAdminMagicLink(adminUserId: number, email: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO admin_magic_links (admin_user_id, email, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '15 minutes')`,
    [adminUserId, email, hashToken(token)]
  );
  return token;
}

export async function consumeAdminMagicLink(token: string): Promise<number | null> {
  const { rows } = await pool.query(
    `UPDATE admin_magic_links SET consumed_at = now()
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING admin_user_id`,
    [hashToken(token)]
  );
  return rows[0]?.admin_user_id ?? null;
}

export async function createAdminSession(adminUserId: number): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO admin_sessions (admin_user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '30 days')`,
    [adminUserId, hashToken(token)]
  );
  return token;
}

export interface AdminSessionInfo {
  adminUserId: number;
  role: 'super_admin' | 'install_staff';
}

export async function resolveAdminSession(token: string): Promise<AdminSessionInfo | null> {
  const { rows } = await pool.query(
    `SELECT au.id AS admin_user_id, au.role
     FROM admin_sessions s
     JOIN admin_users au ON au.id = s.admin_user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  if (rows.length === 0) return null;
  return { adminUserId: rows[0].admin_user_id, role: rows[0].role };
}

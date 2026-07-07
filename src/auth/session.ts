import { randomBytes, createHash } from 'crypto';
import { pool } from '../db/pool';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createMagicLink(propertyId: number, email: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO magic_links (property_id, email, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '15 minutes')`,
    [propertyId, email, hashToken(token)]
  );
  return token;
}

export async function consumeMagicLink(token: string): Promise<number | null> {
  const { rows } = await pool.query(
    `UPDATE magic_links SET consumed_at = now()
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING property_id`,
    [hashToken(token)]
  );
  return rows[0]?.property_id ?? null;
}

export async function createSession(propertyId: number): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO sessions (property_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '30 days')`,
    [propertyId, hashToken(token)]
  );
  return token;
}

export async function resolveSession(token: string): Promise<number | null> {
  const { rows } = await pool.query('SELECT property_id FROM sessions WHERE token_hash = $1 AND expires_at > now()', [
    hashToken(token),
  ]);
  return rows[0]?.property_id ?? null;
}

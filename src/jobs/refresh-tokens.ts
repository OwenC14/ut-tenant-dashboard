import { pool } from '../db/pool';
import { refreshTokens } from '../fox/client';
import { encrypt, decrypt } from '../lib/crypto';

// Scheduled job (spec §4.1 point 5) — tokens are refreshed ahead of expiry on
// a timer, not lazily on-demand, so a stale token can't silently break polling.
const REFRESH_WINDOW_MINUTES = 60;

async function run() {
  const { rows } = await pool.query(
    `SELECT id, fox_refresh_token
     FROM properties
     WHERE fox_refresh_token IS NOT NULL
       AND fox_token_expires_at < now() + interval '${REFRESH_WINDOW_MINUTES} minutes'`
  );

  console.log(`${rows.length} propert${rows.length === 1 ? 'y' : 'ies'} need token refresh`);

  for (const row of rows) {
    try {
      const refreshToken = decrypt(row.fox_refresh_token);
      const tokens = await refreshTokens(refreshToken);
      await pool.query(
        `UPDATE properties
         SET fox_access_token = $1, fox_refresh_token = $2, fox_token_expires_at = $3
         WHERE id = $4`,
        [encrypt(tokens.accessToken), encrypt(tokens.refreshToken), tokens.expiresAt, row.id]
      );
      console.log(`Refreshed tokens for property ${row.id}`);
    } catch (err) {
      console.error(`Failed to refresh tokens for property ${row.id}:`, err);
    }
  }

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

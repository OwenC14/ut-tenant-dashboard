import express from 'express';
import { env } from './config/env';
import { pool } from './db/pool';

const app = express();
app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch {
    res.status(503).json({ status: 'error', db: 'unreachable' });
  }
});

app.listen(env.PORT, () => {
  console.log(`ut-tenant-dashboard API listening on port ${env.PORT}`);
});

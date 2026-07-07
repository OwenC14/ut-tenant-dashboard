import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { pool } from './db/pool';
import { oauthRouter } from './routes/oauth';
import { authRouter } from './routes/auth';
import { dashboardRouter } from './routes/dashboard';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch {
    res.status(503).json({ status: 'error', db: 'unreachable' });
  }
});

app.use('/oauth', oauthRouter);
app.use('/auth', authRouter);
app.use('/api', dashboardRouter);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(502).json({ error: 'upstream request failed' });
});

app.listen(env.PORT, () => {
  console.log(`ut-tenant-dashboard API listening on port ${env.PORT}`);
});

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/error.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import meetingsRouter from './routes/meetings.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({
    origin: (origin, cb) => (!origin || config.allowedOrigins.includes(origin) ? cb(null, true) : cb(null, false)),
    allowedHeaders: ['Authorization', 'Content-Type'],
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(rateLimit({ windowMs: config.rateLimit.windowMs, limit: config.rateLimit.max, standardHeaders: true, legacyHeaders: false }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/v1/auth', authRouter);
  app.use('/v1/users', requireAuth, usersRouter);
  app.use('/v1/meetings', requireAuth, meetingsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

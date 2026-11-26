import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { requireAuth } from './middleware/auth.js';
import { checkFirestore } from './firebase.js';
import { errorHandler, notFound } from './middleware/error.js';
import authRouter from './routes/auth.js';
import usersRouter from './routes/users.js';
import meetingsRouter from './routes/meetings.js';
import aiRouter from './routes/ai.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({
    origin: (origin, cb) => (!origin || config.allowedOrigins.includes(origin) ? cb(null, true) : cb(null, false)),
    allowedHeaders: ['Authorization', 'Content-Type'],
  }));
  app.use(express.json({ limit: '5mb' }));
  app.use(rateLimit({ windowMs: config.rateLimit.windowMs, limit: config.rateLimit.max, standardHeaders: true, legacyHeaders: false }));

  // features lets the extension tell an outdated deployment from a missing meeting.
  app.get('/healthz', (req, res) => res.json({ ok: true, features: ['ai-ask', 'ai-live'] }));
  // Readiness: also proves Firestore is reachable with the configured credentials.
  app.get('/readyz', async (req, res) => {
    const r = await checkFirestore();
    res.status(r.ok ? 200 : 503).json({ ok: r.ok, firestore: r.ok ? 'ok' : { code: r.code, hint: r.hint } });
  });
  app.use('/v1/auth', authRouter);
  app.use('/v1/users', requireAuth, usersRouter);
  app.use('/v1/meetings/:id/ai', requireAuth, aiRouter); // before the meetings router; disjoint paths
  app.use('/v1/meetings', requireAuth, meetingsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

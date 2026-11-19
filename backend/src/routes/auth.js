import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { auth } from '../firebase.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { asyncHandler, httpError } from '../middleware/error.js';

// Manual email/password auth for TEST_MODE only. Firebase's Admin SDK cannot verify
// passwords, so login/refresh go through the Identity Toolkit REST API using the public web API key.
const router = Router();

router.use((req, res, next) => (config.testMode ? next() : res.status(404).json({ error: 'not_found' })));
router.use(rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }));

const signupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
});
const loginSchema = signupSchema.pick({ email: true, password: true });
const refreshSchema = z.object({ refreshToken: z.string().min(1) });

async function identityToolkit(path, body, host = 'identitytoolkit.googleapis.com/v1') {
  if (!config.webApiKey) throw httpError(500, 'misconfigured', 'FIREBASE_WEB_API_KEY is not set');
  const res = await fetch(`https://${host}/${path}?key=${config.webApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error?.message || 'UNKNOWN';
    logger.warn({ code }, 'Identity Toolkit call failed');
    if (/INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS|INVALID_REFRESH_TOKEN|TOKEN_EXPIRED/.test(code)) {
      throw httpError(401, 'invalid_credentials', 'Invalid email or password');
    }
    throw httpError(502, 'auth_upstream_error', 'Authentication service error');
  }
  return data;
}

const session = (d) => ({
  uid: d.localId || d.user_id,
  idToken: d.idToken || d.id_token,
  refreshToken: d.refreshToken || d.refresh_token,
  expiresIn: Number(d.expiresIn || d.expires_in),
});

router.post('/signup', asyncHandler(async (req, res) => {
  const { name, email, password } = signupSchema.parse(req.body);
  try {
    await auth.createUser({ email, password, displayName: name });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') throw httpError(409, 'email_in_use', 'Email already registered');
    throw err;
  }
  const d = await identityToolkit('accounts:signInWithPassword', { email, password, returnSecureToken: true });
  res.status(201).json({ ...session(d), email, displayName: name });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const d = await identityToolkit('accounts:signInWithPassword', { email, password, returnSecureToken: true });
  res.json({ ...session(d), email, displayName: d.displayName || null });
}));

router.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  const d = await identityToolkit('token', { grant_type: 'refresh_token', refresh_token: refreshToken }, 'securetoken.googleapis.com/v1');
  res.json(session(d));
}));

export default router;

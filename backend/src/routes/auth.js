import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { auth } from '../firebase.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { asyncHandler, httpError } from '../middleware/error.js';

// Sign-in endpoints for the extension. The Admin SDK cannot verify passwords or Google
// credentials, so both flows go through the Firebase Identity Toolkit REST API using the
// project's public web API key. The backend never stores a password or Google secret; it
// only relays Firebase-issued tokens. Nothing here depends on the hosting provider.
const router = Router();

const limiter = (limit) => rateLimit({ windowMs: 60_000, limit, standardHeaders: true, legacyHeaders: false });
const signInLimiter = limiter(20);
const refreshLimiter = limiter(60);

const signupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
});
const loginSchema = signupSchema.pick({ email: true, password: true });
const refreshSchema = z.object({ refreshToken: z.string().min(1) });
const googleSchema = z.object({ idToken: z.string().min(20).max(8192) });

async function identityToolkit(path, body, host = 'identitytoolkit.googleapis.com/v1') {
  if (!config.webApiKey) throw httpError(500, 'misconfigured', 'FIREBASE_WEB_API_KEY is not set');
  const res = await fetch(`https://${host}/${path}?key=${config.webApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error?.message || 'UNKNOWN';
    logger.warn({ code, path }, 'Identity Toolkit call failed');
    if (/INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS|INVALID_REFRESH_TOKEN|TOKEN_EXPIRED|USER_DISABLED|USER_NOT_FOUND|INVALID_IDP_RESPONSE|INVALID_ID_TOKEN/.test(code)) {
      throw httpError(401, 'invalid_credentials', path.includes('signInWithIdp') ? 'Google sign-in was rejected' : 'Invalid email or password');
    }
    if (/OPERATION_NOT_ALLOWED/.test(code)) {
      throw httpError(503, 'provider_disabled', 'This sign-in method is not enabled in Firebase Authentication');
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

// Capabilities for the client UI: which sign-in methods exist and the Google client to use.
router.get('/config', (req, res) => {
  res.json({ password: config.passwordAuthEnabled, google: !!config.googleClientId, googleClientId: config.googleClientId });
});

const passwordOnly = (req, res, next) => (config.passwordAuthEnabled ? next() : res.status(404).json({ error: 'not_found' }));

router.post('/signup', passwordOnly, signInLimiter, asyncHandler(async (req, res) => {
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

router.post('/login', passwordOnly, signInLimiter, asyncHandler(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const d = await identityToolkit('accounts:signInWithPassword', { email, password, returnSecureToken: true });
  res.json({ ...session(d), email, displayName: d.displayName || null });
}));

// Google sign-in: exchange a Google ID token (obtained by the extension through the browser's
// OAuth flow) for a Firebase session. Firebase verifies signature, issuer, expiry and audience.
router.post('/google', signInLimiter, asyncHandler(async (req, res) => {
  if (!config.googleClientId) throw httpError(503, 'provider_disabled', 'Google sign-in is not configured (GOOGLE_OAUTH_CLIENT_ID)');
  const { idToken } = googleSchema.parse(req.body);
  const d = await identityToolkit('accounts:signInWithIdp', {
    postBody: `id_token=${encodeURIComponent(idToken)}&providerId=google.com`,
    requestUri: 'http://localhost',
    returnIdpCredential: true,
    returnSecureToken: true,
  });
  res.json({ ...session(d), email: d.email || null, displayName: d.displayName || null, photoURL: d.photoUrl || null });
}));

router.post('/refresh', refreshLimiter, asyncHandler(async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  const d = await identityToolkit('token', { grant_type: 'refresh_token', refresh_token: refreshToken }, 'securetoken.googleapis.com/v1');
  res.json(session(d));
}));

export default router;

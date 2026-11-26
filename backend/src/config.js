import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env.NODE_ENV || 'development';

// Real process env vars always win; then the env-specific file; then .env.
dotenv.config({ path: path.join(root, `.env.${env}`) });
dotenv.config({ path: path.join(root, '.env') });

const isPlaceholder = (v) => !v || /REPLACE/i.test(v);
const isProd = env === 'production';

// Tolerates stray surrounding quotes/whitespace and both literal "\n" and real newlines.
function normalizePrivateKey(raw) {
  return raw.trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n').trim() + '\n';
}

function buildCredentialConfig() {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, GOOGLE_APPLICATION_CREDENTIALS } = process.env;
  if (process.env.FIRESTORE_EMULATOR_HOST) return { mode: 'emulator', projectId: FIREBASE_PROJECT_ID };
  if (!isPlaceholder(FIREBASE_CLIENT_EMAIL) && !isPlaceholder(FIREBASE_PRIVATE_KEY)) {
    return {
      mode: 'env',
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: normalizePrivateKey(FIREBASE_PRIVATE_KEY),
    };
  }
  if (GOOGLE_APPLICATION_CREDENTIALS) return { mode: 'file', projectId: FIREBASE_PROJECT_ID };
  // On GCP (Cloud Run etc.) application default credentials come from the attached service identity.
  return { mode: 'adc', projectId: FIREBASE_PROJECT_ID };
}

export const config = {
  env,
  isProd,
  port: Number(process.env.PORT || 8080),
  logLevel: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter((s) => s && !isPlaceholder(s)),
  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
    max: Number(process.env.RATE_LIMIT_MAX || 120),
  },
  firebase: buildCredentialConfig(),
  // Email/password sign-in goes through Firebase Identity Toolkit (the Admin SDK cannot verify
  // passwords), so it needs the public web API key. On by default; AUTH_PASSWORD_ENABLED=false
  // turns it off (Google sign-in stays available).
  passwordAuthEnabled: process.env.AUTH_PASSWORD_ENABLED !== 'false',
  // Google sign-in: the extension obtains a Google ID token for this OAuth client and the
  // backend exchanges it for a Firebase session. Public identifier, not a secret.
  googleClientId: isPlaceholder(process.env.GOOGLE_OAUTH_CLIENT_ID) ? null : process.env.GOOGLE_OAUTH_CLIENT_ID.trim(),
  webApiKey: isPlaceholder(process.env.FIREBASE_WEB_API_KEY) ? null : process.env.FIREBASE_WEB_API_KEY.trim(),
  // Claude answers + Ask Meet Memo. SECRET: the key is read here only and used only by src/ai/client.js.
  // Optional: without a key the server still starts and the AI routes answer 503.
  ai: {
    apiKey: isPlaceholder(process.env.ANTHROPIC_API_KEY) ? null : process.env.ANTHROPIC_API_KEY.trim(),
    enabled: process.env.AI_ENABLED !== 'false',
    model: process.env.AI_MODEL?.trim() || 'claude-haiku-5-5',
    questionsPerWindow: Number(process.env.AI_RATE_LIMIT_PER_10MIN || 20),
    // Live auto-answer. Defaults to AI_MODEL (Claude Haiku) so one variable switches both.
    liveModel: process.env.AI_LIVE_MODEL?.trim() || process.env.AI_MODEL?.trim() || 'claude-haiku-5-5',
    livePerWindow: Number(process.env.AI_LIVE_RATE_LIMIT_PER_10MIN || 60),
  },
};

export function validateConfig() {
  const problems = [];
  if (!config.firebase.projectId) problems.push('FIREBASE_PROJECT_ID is not set');
  if (config.firebase.mode === 'adc' && !isProd) {
    problems.push('No Firebase credentials found: set FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY, GOOGLE_APPLICATION_CREDENTIALS, or FIRESTORE_EMULATOR_HOST');
  }
  if (isProd && config.allowedOrigins.length === 0) problems.push('ALLOWED_ORIGINS must be set in production');
  if (!config.webApiKey) problems.push('FIREBASE_WEB_API_KEY is not set (Firebase Console > Project settings > General > Web API Key)');
  if (problems.length) throw new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
}

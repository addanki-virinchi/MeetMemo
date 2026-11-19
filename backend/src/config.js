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

function buildCredentialConfig() {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, GOOGLE_APPLICATION_CREDENTIALS } = process.env;
  if (process.env.FIRESTORE_EMULATOR_HOST) return { mode: 'emulator', projectId: FIREBASE_PROJECT_ID };
  if (!isPlaceholder(FIREBASE_CLIENT_EMAIL) && !isPlaceholder(FIREBASE_PRIVATE_KEY)) {
    return {
      mode: 'env',
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
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
  testMode: process.env.TEST_MODE === 'true',
  webApiKey: isPlaceholder(process.env.FIREBASE_WEB_API_KEY) ? null : process.env.FIREBASE_WEB_API_KEY,
};

export function validateConfig() {
  const problems = [];
  if (!config.firebase.projectId) problems.push('FIREBASE_PROJECT_ID is not set');
  if (config.firebase.mode === 'adc' && !isProd) {
    problems.push('No Firebase credentials found: set FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY, GOOGLE_APPLICATION_CREDENTIALS, or FIRESTORE_EMULATOR_HOST');
  }
  if (isProd && config.allowedOrigins.length === 0) problems.push('ALLOWED_ORIGINS must be set in production');
  if (isProd && config.testMode) problems.push('TEST_MODE must not be true in production');
  if (config.testMode && !config.webApiKey) problems.push('TEST_MODE=true requires FIREBASE_WEB_API_KEY');
  if (problems.length) throw new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
}

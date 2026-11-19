import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config.js';
import { logger } from './logger.js';

function init() {
  if (getApps().length) return getApps()[0];
  const { mode, projectId, clientEmail, privateKey } = config.firebase;
  const options = { projectId };
  if (mode === 'env') options.credential = cert({ projectId, clientEmail, privateKey });
  else if (mode === 'file' || mode === 'adc') options.credential = applicationDefault();
  logger.info({ credentialMode: mode, projectId }, 'Initializing Firebase Admin');
  return initializeApp(options);
}

const app = init();
export const auth = getAuth(app);
export const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });

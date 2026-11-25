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

// Plain-language cause for the Firestore failures seen in practice (gRPC status codes).
export function firestoreHint(err) {
  switch (err?.code) {
    case 5: return 'Firestore database not found: create it in Firebase Console > Build > Firestore Database (Native mode, database id "(default)")';
    case 7: return 'Permission denied: the service account needs the "Cloud Datastore User" role and the Cloud Firestore API must be enabled for the project';
    case 8: return 'Resource exhausted: Firestore quota exceeded, or the project is on a plan/region that rejects this request; see the logged message and Firebase Console > Usage';
    case 9: return 'Missing composite index: deploy backend/firestore.indexes.json (firebase deploy --only firestore:indexes)';
    case 16: return 'Invalid credentials: check FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY belong to this FIREBASE_PROJECT_ID';
    default: return null;
  }
}

// Reads one document: proves credentials, project id and database existence end to end.
export async function checkFirestore() {
  try {
    await db.collection('_health').doc('ping').get();
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code ?? null, message: err.message, hint: firestoreHint(err) };
  }
}

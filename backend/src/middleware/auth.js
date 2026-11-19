import { auth } from '../firebase.js';
import { logger } from '../logger.js';

// Verifies a Firebase ID token (obtained client-side after Google Sign-In).
// The backend never sees Google credentials, only the Firebase-issued ID token.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) return res.status(401).json({ error: 'unauthenticated', message: 'Missing bearer token' });
  try {
    const decoded = await auth.verifyIdToken(match[1], true); // true = check revocation
    req.user = { uid: decoded.uid, email: decoded.email ?? null, name: decoded.name ?? null, picture: decoded.picture ?? null };
    next();
  } catch (err) {
    logger.warn({ code: err.code }, 'Token verification failed');
    res.status(401).json({ error: 'unauthenticated', message: 'Invalid or expired token' });
  }
}

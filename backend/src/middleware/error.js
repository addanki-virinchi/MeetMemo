import { ZodError } from 'zod';
import { logger } from '../logger.js';
import { firestoreHint } from '../firebase.js';

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const httpError = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });

// Unknown endpoint. Deliberately not 'not_found': that code means "this meeting does not exist
// for your account", and an outdated server answering a newer route with it made the extension
// report a missing meeting when the route itself was missing.
export function notFound(req, res) {
  res.status(404).json({ error: 'route_not_found', message: 'This MeetMemo server does not have that endpoint. It may be running an older version.' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'invalid_request',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  // 5xx are only passed through when raised deliberately with httpError (e.g. provider not configured).
  if (err.status && (err.status < 500 || (err.status < 600 && typeof err.code === 'string' && err.expose === true))) return res.status(err.status).json({ error: err.code || 'error', message: err.message });
  logger.error({ err: { message: err.message, stack: err.stack, code: err.code }, hint: firestoreHint(err) ?? undefined }, 'Unhandled error');
  // Never leak internals (or credentials embedded in error text) to clients.
  res.status(500).json({ error: 'internal_error' });
}

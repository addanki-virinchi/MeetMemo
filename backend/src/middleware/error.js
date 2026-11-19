import { ZodError } from 'zod';
import { logger } from '../logger.js';

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });

export function notFound(req, res) {
  res.status(404).json({ error: 'not_found' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'invalid_request',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.code || 'error', message: err.message });
  logger.error({ err: { message: err.message, stack: err.stack, code: err.code } }, 'Unhandled error');
  // Never leak internals (or credentials embedded in error text) to clients.
  res.status(500).json({ error: 'internal_error' });
}

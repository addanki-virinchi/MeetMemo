import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  // Defence in depth: never let credentials or tokens reach logs.
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.privateKey', '*.private_key', '*.token', '*.idToken'],
    censor: '[redacted]',
  },
});

import { config, validateConfig } from './config.js';
import { logger } from './logger.js';

try {
  validateConfig();
} catch (err) {
  logger.fatal(err.message);
  process.exit(1);
}

// Import after validation so Firebase init only ever sees a valid config.
const { createApp } = await import('./app.js');
const { checkFirestore } = await import('./firebase.js');
const server = createApp().listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'MeetMemo API listening');
  if (!config.ai.enabled) logger.info('Claude AI is switched off (AI_ENABLED=false)');
  else if (!config.ai.apiKey) logger.warn('Claude AI is off: ANTHROPIC_API_KEY is not set');
  else logger.info({ model: config.ai.model }, 'Claude AI enabled');
});

// Surface Firestore problems at boot instead of on the first transcript save.
checkFirestore().then((r) => {
  if (r.ok) logger.info('Firestore connection verified');
  else logger.error({ code: r.code, hint: r.hint, message: r.message }, 'Firestore check FAILED: transcripts cannot be saved until this is fixed');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
process.on('unhandledRejection', (r) => logger.error({ reason: String(r) }, 'unhandledRejection'));

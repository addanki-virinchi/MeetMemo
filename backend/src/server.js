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
const server = createApp().listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'MeetMemo API listening');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
process.on('unhandledRejection', (r) => logger.error({ reason: String(r) }, 'unhandledRejection'));

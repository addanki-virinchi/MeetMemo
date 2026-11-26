import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { config } from '../config.js';
import { createAnthropicClient } from '../ai/client.js';
import { createContextDocsRouter } from './contextDocsRouter.js';

// Route logic lives in contextDocsRouter.js (testable without Firebase or Anthropic credentials).
export default createContextDocsRouter({
  db,
  FieldValue,
  anthropic: createAnthropicClient(config.ai),
  model: config.ai.model,
});

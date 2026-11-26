import { FieldValue, FieldPath } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { config } from '../config.js';
import { createAnthropicClient } from '../ai/client.js';
import { createAiRouter } from './aiRouter.js';

// Route logic lives in aiRouter.js (testable without Firebase or Anthropic credentials).
export default createAiRouter({
  db,
  FieldValue,
  FieldPath,
  anthropic: createAnthropicClient(config.ai),
  model: config.ai.model,
  questionsPerWindow: config.ai.questionsPerWindow,
  liveModel: config.ai.liveModel,
  livePerWindow: config.ai.livePerWindow,
});

import Anthropic from '@anthropic-ai/sdk';

// User-facing wording for every way an answer can fail. Codes are stable; the panel keys off them.
export const AI_MESSAGES = {
  ai_unavailable: "Claude isn't set up on this server right now.",
  ai_busy: 'Claude is busy right now. Try again in a minute.',
  ai_unreachable: "Couldn't reach Claude. Try again in a moment.",
  ai_declined: "Claude couldn't answer this question. Try asking it a different way.",
  empty_answer: 'No answer came back. Try again or rephrase the question.',
  ai_failed: 'Something went wrong while answering. Try again.',
  ai_timeout: 'Claude took too long to answer. Try again.',
  ai_live_busy: 'Claude is still answering earlier questions from this meeting.',
  stopped: 'The answer was stopped before it finished.',
};

// Maps an Anthropic SDK error to { code, log }. `log` says whether ops should look at it;
// error text from the API is never sent to the client.
export function mapAiError(err) {
  if (err instanceof Anthropic.RateLimitError) return { code: 'ai_busy', log: 'warn' };
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return { code: 'ai_unavailable', log: 'error' };
  if (err instanceof Anthropic.APIConnectionError) return { code: 'ai_unreachable', log: 'warn' }; // includes timeouts
  if (err instanceof Anthropic.InternalServerError || err?.status === 529) return { code: 'ai_busy', log: 'warn' };
  if (err instanceof Anthropic.APIError) return { code: 'ai_failed', log: 'error' };
  return { code: 'ai_failed', log: 'error' };
}

import Anthropic from '@anthropic-ai/sdk';

// The only place the Anthropic API key is used. It comes from the server environment
// (ANTHROPIC_API_KEY) and is never sent to the extension or written to logs.
// Returns null when AI is switched off or no key is configured; routes then answer 503.
export function createAnthropicClient(ai) {
  if (!ai?.enabled || !ai.apiKey) return null;
  return new Anthropic({ apiKey: ai.apiKey, maxRetries: 2, timeout: 120_000 });
}

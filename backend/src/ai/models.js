import { z } from 'zod';

// The models and effort levels a user can pick in the extension (Claude tab model picker,
// sync/assist-dock.js). The client sends { model, effort }; anything else is rejected by the
// schemas below, so a request can never name an arbitrary model.
//
// Request rules differ per model (Claude API, November 2026):
//   Haiku 5.5   thinking can be disabled (at effort high or below)
//   Sonnet 5.5  { type: 'disabled' } is a 400; { type: 'between_tools' } turns it off (high or below)
//   Opus 5.5    thinking can't be turned off; omit `thinking` and use effort to keep it short
export const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
export const EFFORTS = ['low', 'medium', 'high'];
export const DEFAULT_EFFORT = 'low'; // what every route used before the picker existed

export const modelField = z.enum(MODELS).optional();
export const effortField = z.enum(EFFORTS).optional();

// Fills model, effort and thinking on a Messages request.
//   base         the route's request params (model is replaced)
//   choice       { model?, effort? } from the request body (already validated)
//   fallback     the server's configured model when the user picked none
//   thinkingOff  the route wants no thinking (live auto-answer: time to first text matters)
//   minTokens    max_tokens floor once the model may think, so thinking can't eat the answer
export function applyModelChoice(base, { model, effort } = {}, { fallback, thinkingOff = false, minTokens = 16_000 } = {}) {
  const chosen = model || fallback;
  const level = effort || DEFAULT_EFFORT;
  const params = { ...base, model: chosen, output_config: { ...base.output_config, effort: level } };
  delete params.thinking;
  let thinks = true;
  if (thinkingOff) {
    if (chosen.startsWith('claude-haiku-')) { params.thinking = { type: 'disabled' }; thinks = false; }
    else if (chosen.startsWith('claude-sonnet-')) { params.thinking = { type: 'between_tools' }; thinks = false; }
    // Opus: no way to switch it off; leave `thinking` out.
  }
  if (thinks && level !== 'low') params.max_tokens = Math.max(params.max_tokens || 0, minTokens);
  else if (thinks) params.max_tokens = Math.max(params.max_tokens || 0, Math.min(minTokens, 4_000));
  return params;
}

// Bigger models at higher effort take longer; routes with hard timeouts scale them by this.
export function slowness({ model, effort } = {}, fallback) {
  const m = model || fallback || '';
  const e = effort || DEFAULT_EFFORT;
  const byModel = m.startsWith('claude-opus-') ? 2.5 : m.startsWith('claude-sonnet-') ? 1.75 : 1;
  const byEffort = e === 'high' ? 2 : e === 'medium' ? 1.4 : 1;
  return Math.round(byModel * byEffort * 100) / 100;
}

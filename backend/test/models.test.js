// Model and effort picker: per-model request rules (backend/src/ai/models.js) and the assist
// route honouring a user's choice. No credentials or network are used. Run with: npm test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { applyModelChoice, slowness } from '../src/ai/models.js';
import { createMeetingsRouter } from '../src/routes/meetingsRouter.js';
import { createAiRouter } from '../src/routes/aiRouter.js';
import { errorHandler, notFound } from '../src/middleware/error.js';
import { createFakeFirestore, FieldValue, FieldPath } from './fakeFirestore.js';

const base = { max_tokens: 400, messages: [] };

test('MOD-01: no choice keeps the server model at low effort', () => {
  const p = applyModelChoice(base, {}, { fallback: 'claude-haiku-5-5', thinkingOff: true });
  assert.equal(p.model, 'claude-haiku-5-5');
  assert.deepEqual(p.output_config, { effort: 'low' });
  assert.deepEqual(p.thinking, { type: 'disabled' });
  assert.equal(p.max_tokens, 400);
});

test('MOD-02: thinking-off routes use what each model accepts', () => {
  const sonnet = applyModelChoice(base, { model: 'claude-sonnet-5-5', effort: 'high' }, { fallback: 'claude-haiku-5-5', thinkingOff: true });
  assert.deepEqual(sonnet.thinking, { type: 'between_tools' }, 'Sonnet 5.5 rejects disabled');
  assert.equal(sonnet.output_config.effort, 'high');
  assert.equal(sonnet.max_tokens, 400);

  const opus = applyModelChoice(base, { model: 'claude-opus-5-5', effort: 'medium' }, { fallback: 'claude-haiku-5-5', thinkingOff: true });
  assert.equal(opus.thinking, undefined, 'Opus 5.5 cannot turn thinking off');
  assert.ok(opus.max_tokens >= 16_000, 'room for thinking before the answer');

  const opusLow = applyModelChoice(base, { model: 'claude-opus-5-5', effort: 'low' }, { fallback: 'claude-haiku-5-5', thinkingOff: true });
  assert.equal(opusLow.max_tokens, 4_000);
});

test('MOD-03: slower models and higher effort get longer timeouts', () => {
  assert.equal(slowness({}, 'claude-haiku-5-5'), 1);
  assert.ok(slowness({ model: 'claude-opus-5-5', effort: 'high' }) > slowness({ model: 'claude-sonnet-5-5', effort: 'medium' }));
});

let server; let url; const calls = [];
before(async () => {
  const db = createFakeFirestore();
  const anthropic = {
    messages: {
      async parse(params) {
        calls.push(params);
        return { stop_reason: 'end_turn', parsed_output: { found: true, question: 'Price?', text: 'It is 1,200 EUR.' }, usage: {} };
      },
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { uid: 'M1' }; next(); });
  app.use('/v1/meetings/:id/ai', createAiRouter({ db, FieldValue, FieldPath, anthropic, model: 'claude-haiku-5-5', assistPerWindow: 1000 }));
  app.use('/v1/meetings', createMeetingsRouter({ db, FieldValue, FieldPath }));
  app.use(notFound);
  app.use(errorHandler);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const post = async (path, body) => {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('MOD-04: the assist route uses the picked model and effort and reports them back', async () => {
  const m = await post('/v1/meetings', { title: 'Pricing call', platform: 'googlemeet', segmentIdScheme: 2 });
  const r = await post(`/v1/meetings/${m.body.id}/ai/assist`, { action: 'answer', model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.model, 'claude-sonnet-5-5');
  assert.equal(r.body.effort, 'medium');
  assert.equal(calls.at(-1).model, 'claude-sonnet-5-5');
  assert.equal(calls.at(-1).output_config.effort, 'medium');
  assert.equal(calls.at(-1).output_config.format.type, 'json_schema', 'structured output kept');

  const bad = await post(`/v1/meetings/${m.body.id}/ai/assist`, { action: 'answer', model: 'claude-fable-5-2' });
  assert.equal(bad.status, 400, 'models outside the picker are refused');
});

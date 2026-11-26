// Live auto-answer routes and parser, against the in-memory Firestore fake and a scripted
// fake Anthropic client. No credentials or network are used. Run with: npm test (from backend/).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { createMeetingsRouter } from '../src/routes/meetingsRouter.js';
import { createAiRouter } from '../src/routes/aiRouter.js';
import { errorHandler, notFound } from '../src/middleware/error.js';
import { createFakeFirestore, FieldValue, FieldPath } from './fakeFirestore.js';
import { createLiveParser, mergeLiveContext, validateSources, LIVE_SYSTEM } from '../src/ai/live.js';

// ---- scripted provider ----
// chunks: text deltas; hangBefore: never send anything (until aborted); hangAfter: stall after
// the chunks; throwError: fail on the first read; onStart(params): hook when a stream opens.
const calls = [];
let script;
function fakeStream(params, options) {
  calls.push({ params, options });
  const s = script;
  let aborted = false;
  let wake = null;
  const stall = () => new Promise((r) => { wake = r; });
  options?.signal?.addEventListener('abort', () => { aborted = true; wake?.(); });
  s.onStart?.(params);
  return {
    abort() { aborted = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      if (s.throwError) throw s.throwError;
      if (s.hangBefore) await stall();
      for (const text of s.chunks) {
        if (aborted) throw new Anthropic.APIUserAbortError();
        if (s.gate) await s.gate;
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
      }
      if (s.hangAfter) await stall();
      if (aborted) throw new Anthropic.APIUserAbortError();
    },
    async finalMessage() { return { stop_reason: s.stopReason || 'end_turn', usage: { input_tokens: 200, output_tokens: 40 } }; },
  };
}

let server; let base; let db;
before(async () => {
  db = createFakeFirestore();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { uid: req.get('x-test-uid') }; next(); });
  app.use('/v1/meetings/:id/ai', createAiRouter({
    db, FieldValue, FieldPath, anthropic: { messages: { stream: fakeStream } }, model: 'claude-haiku-5-5',
    questionsPerWindow: 1000, livePerWindow: 1000, liveOptions: { firstTokenMs: 150, totalMs: 400 },
  }));
  app.use('/v1/meetings', createMeetingsRouter({ db, FieldValue, FieldPath }));
  app.use(notFound);
  app.use(errorHandler);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));
beforeEach(() => { calls.length = 0; script = { chunks: ['SKIP'] }; });

async function call(uid, method, path, body) {
  const res = await fetch(`${base}/v1/meetings${path}`, {
    method,
    headers: { 'x-test-uid': uid, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const type = res.headers.get('content-type') || '';
  const events = type.includes('event-stream')
    ? text.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => { const [e, d] = b.split('\n'); return { event: e.slice(7), data: JSON.parse(d.slice(6)) }; })
    : [];
  return { status: res.status, type, body: type.includes('json') && text ? JSON.parse(text) : text, events };
}

const T0 = Date.UTC(2026, 10, 26, 15, 0);
const LINES = [
  { id: 'm2_a1', speaker: 'Priya', text: 'We plan to roll out the new billing flow to all EU customers in January.', ts: T0 },
  { id: 'm2_a2', speaker: 'Marcus', text: 'Support only has two people over the holidays and finance wants no invoice changes before Q1 close.', ts: T0 + 20_000 },
  { id: 'm2_a3', speaker: 'Priya', text: 'how would our business constraints affect this rollout', ts: T0 + 40_000 },
];

async function liveMeeting(uid = 'A', saved = LINES.slice(0, 2)) {
  const r = await call(uid, 'POST', '/', { title: 'Billing rollout', platform: 'googlemeet', segmentIdScheme: 2 });
  if (saved.length) await call(uid, 'POST', `/${r.body.id}/segments`, { segments: saved.map(({ id, ...s }) => ({ messageId: id, ...s })) });
  return r.body.id;
}

const candidate = (q = LINES[2], extra = {}) => ({
  questionId: q.id,
  question: { text: q.text, speaker: q.speaker, ts: q.ts },
  context: LINES.filter((l) => l.ts <= q.ts),
  timeZone: 'UTC',
  ...extra,
});

const answerOf = (r) => r.events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');

// ------------------------------------------------------------------ parser

test('LIVE-PARSE-01: decision line, streamed answer, SOURCE_IDS split across chunks never leaks', () => {
  const p = createLiveParser();
  const out = [];
  for (const c of ['ANS', 'WER\nShipping in January ', 'collides with Q1 close [L2]. ', 'Consider February.\nSOUR', 'CE_IDS: L2, L1, L9']) out.push(...p.push(c));
  const fin = p.finish();
  assert.deepEqual(out[0], { type: 'decision', decision: 'answer' });
  const text = out.filter((e) => e.type === 'text').map((e) => e.text).join('') + fin.text;
  assert.equal(text, 'Shipping in January collides with Q1 close [L2]. Consider February.');
  assert.ok(!/SOUR/i.test(text));
  assert.deepEqual(fin.sourceLabels, ['L2', 'L1', 'L9']);
  assert.deepEqual(validateSources(fin.sourceLabels, new Map([['L1', 'm2_a1'], ['L2', 'm2_a2']])), ['m2_a2', 'm2_a1'], 'unknown ids are dropped');
});

test('LIVE-PARSE-02: SKIP, markdown decision, same-line answer, empty sources, no decision', () => {
  let p = createLiveParser();
  assert.deepEqual(p.push('SKIP'), []);
  assert.equal(p.finish().decision, 'skip');
  p = createLiveParser();
  assert.deepEqual(p.push('SKIP\n'), [{ type: 'decision', decision: 'skip' }]);
  p = createLiveParser();
  const ev = p.push('**ANSWER**\nA Python list is an ordered, mutable sequence.\nSOURCE_IDS:');
  assert.equal(ev[0].decision, 'answer');
  assert.equal(ev.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'A Python list is an ordered, mutable sequence.');
  assert.deepEqual(p.finish().sourceLabels, []);
  p = createLiveParser();
  const inline = p.push('ANSWER: Lists are mutable.');
  assert.equal(inline[0].decision, 'answer');
  assert.equal(inline.filter((e) => e.type === 'text').map((e) => e.text).join('') + p.finish().text, 'Lists are mutable.');
  p = createLiveParser();
  assert.deepEqual(p.push('Sure, here is what I think about that question in detail'), [{ type: 'decision', decision: 'invalid' }]);
});

test('LIVE-PARSE-03: context merge keeps the last turns up to the question; client revision wins', () => {
  const saved = [{ id: 'm2_old', speaker: 'X', text: 'old', ts: 1 }, { id: 'm2_q', speaker: 'P', text: 'how would we', ts: 50 }];
  const client = [{ id: 'm2_q', speaker: 'P', text: 'how would we roll this out', ts: 50 }];
  const merged = mergeLiveContext({ question: { id: 'm2_q', text: 'how would we roll this out', ts: 50 }, clientLines: client, savedLines: saved });
  assert.deepEqual(merged.map((l) => l.id), ['m2_old', 'm2_q']);
  assert.equal(merged[1].text, 'how would we roll this out');
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `m2_${i}`, text: `line ${i}`, ts: i }));
  const tail = mergeLiveContext({ question: { id: 'm2_20', text: 'q?', ts: 20 }, savedLines: many });
  assert.equal(tail.length, 12);
  assert.equal(tail.at(-1).id, 'm2_20', 'nothing after the question');
});

// ------------------------------------------------------------------ routes

test('LIVE-01: a business-impact question streams a card, contextual answer and validated sources', async () => {
  const id = await liveMeeting();
  script = { chunks: ['ANSWER\n', 'A January rollout lands on thin holiday support and the Q1 close freeze [L2]. ', 'Consider a February start for EU billing [L1].\n', 'SOURCE_IDS: L1, L2, L7'] };
  const r = await call('A', 'POST', `/${id}/ai/live/answer`, candidate());
  assert.equal(r.status, 200);
  assert.deepEqual(r.events.map((e) => e.event).filter((e) => e !== 'delta'), ['card', 'sources', 'done']);
  assert.equal(r.events[0].data.questionId, 'm2_a3');
  assert.match(answerOf(r), /^A January rollout.*February start for EU billing \[L1\]\.$/);
  assert.deepEqual(r.events.find((e) => e.event === 'sources').data.ids, ['m2_a1', 'm2_a2'], 'L7 was never supplied');

  // Request shape: server-side model, no thinking, low effort, the spec prompt, the bounded excerpt.
  const { params } = calls[0];
  assert.equal(params.model, 'claude-haiku-5-5');
  assert.deepEqual(params.thinking, { type: 'disabled' });
  assert.deepEqual(params.output_config, { effort: 'low' });
  assert.equal(params.temperature, undefined);
  assert.ok(params.system[0].text.startsWith(LIVE_SYSTEM.slice(0, 60)));
  assert.match(params.messages[0].content, /\[L2 15:00:20\] Marcus: Support only has two people/);
  assert.match(params.messages[0].content, /<candidate id="L3" speaker="Priya">\nhow would our business constraints affect this rollout\n<\/candidate>/);

  // Persisted with the meeting; reload restores it without a model call.
  const list = await call('A', 'GET', `/${id}/ai/live`);
  assert.equal(list.body.enabled, true);
  assert.equal(list.body.cards.length, 1);
  assert.equal(list.body.cards[0].status, 'answered');
  assert.deepEqual(list.body.cards[0].sources, ['m2_a1', 'm2_a2']);
  assert.equal(list.body.cards[0].question.speaker, 'Priya');
  assert.equal(calls.length, 1);
  const card = db.store.get(`meetings/${id}/aiLive/m2_a3`);
  assert.ok(!JSON.stringify(card).includes('Support only has two people'), 'context text is not stored');
});

test('LIVE-02: a technical question without a question mark is answered; small talk makes no card', async () => {
  const id = await liveMeeting('A', []);
  const q = { id: 'm2_py', speaker: 'Dev', text: 'how would you define a Python list', ts: T0 };
  script = { chunks: ['ANSWER\nA Python list is an ordered, mutable sequence that can hold items of any type. ', 'You create one with square brackets, like [1, 2, 3].\nSOURCE_IDS:'] };
  const r = await call('A', 'POST', `/${id}/ai/live/answer`, { ...candidate(q), context: [q] });
  assert.equal(r.events[0].event, 'card');
  assert.match(answerOf(r), /ordered, mutable sequence/);
  assert.deepEqual(r.events.find((e) => e.event === 'sources').data.ids, []);

  for (const [n, text] of [['day', 'How was your day?'], ['do', 'so what do you do'], ['hear', 'Can you hear me?']]) {
    script = { chunks: ['SK', 'IP\n', 'should never be read'] };
    const s = await call('A', 'POST', `/${id}/ai/live/answer`, { ...candidate({ id: `m2_${n}`, speaker: 'Sam', text, ts: T0 + 1000 }), context: [] });
    assert.deepEqual(s.events.map((e) => e.event), ['done'], text);
    assert.equal(s.events[0].data.status, 'skipped');
  }
  const list = await call('A', 'GET', `/${id}/ai/live`);
  assert.deepEqual(list.body.cards.map((c) => c.questionId), ['m2_py'], 'skips are not cards');
});

test('LIVE-03: duplicate deliveries, revisions and retries never call the model twice or make two cards', async () => {
  const id = await liveMeeting();
  script = { chunks: ['ANSWER\nPush to February.\nSOURCE_IDS: L2'] };
  await call('A', 'POST', `/${id}/ai/live/answer`, candidate());
  const again = await call('A', 'POST', `/${id}/ai/live/answer`, candidate());
  assert.equal(again.status, 200);
  assert.equal(again.body.status, 'exists');
  assert.equal(again.body.card.answer, 'Push to February.');
  const revised = await call('A', 'POST', `/${id}/ai/live/answer`, candidate({ ...LINES[2], text: `${LINES[2].text} given the holidays and the freeze` }));
  assert.equal(revised.body.status, 'exists', 'a revision of an answered question does not re-answer');
  assert.equal(calls.length, 1);

  // Concurrent duplicate while the first is still streaming: 409, still one call.
  const q = { id: 'm2_dup', speaker: 'P', text: 'what is the rollback plan', ts: T0 + 60_000 };
  let open; script = { chunks: ['ANSWER\nRoll back by flag.'], gate: new Promise((r) => { open = r; }) };
  const first = call('A', 'POST', `/${id}/ai/live/answer`, { ...candidate(q), context: [q] });
  await new Promise((r) => setTimeout(r, 50));
  const second = await call('A', 'POST', `/${id}/ai/live/answer`, { ...candidate(q), context: [q] });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'in_progress');
  open();
  assert.equal((await first).events[0].event, 'card');
  assert.equal(calls.length, 2);
});

test('LIVE-04: an unfinished caption that was skipped is re-checked once it grows', async () => {
  const id = await liveMeeting('A', []);
  const part = { id: 'm2_grow', speaker: 'P', text: 'how would the', ts: T0 };
  script = { chunks: ['SKIP'] };
  await call('A', 'POST', `/${id}/ai/live/answer`, { ...candidate(part), context: [] });
  const same = await call('A', 'POST', `/${id}/ai/live/answer`, { ...candidate({ ...part, text: 'how would the new' }), context: [] });
  assert.equal(same.body.status, 'exists');
  script = { chunks: ['ANSWER\nIt depends on support coverage.'] };
  const grown = await call('A', 'POST', `/${id}/ai/live/answer`, { ...candidate({ ...part, text: 'how would the new pricing affect churn' }), context: [] });
  assert.equal(grown.events[0].event, 'card');
  assert.equal(calls.length, 2);
});

test('LIVE-05: wrong account, deleted meeting and missing meeting are 404 before any model call', async () => {
  const id = await liveMeeting('A');
  const other = await call('B', 'POST', `/${id}/ai/live/answer`, candidate());
  assert.equal(other.status, 404);
  assert.equal(other.body.error, 'not_found');
  assert.equal((await call('B', 'GET', `/${id}/ai/live`)).status, 404);
  assert.equal(calls.length, 0, 'no model call for another account');

  script = { chunks: ['ANSWER\nYes.'] };
  await call('A', 'POST', `/${id}/ai/live/answer`, candidate());
  assert.equal((await call('A', 'DELETE', `/${id}`)).status, 204);
  assert.equal([...db.store.keys()].filter((k) => k.includes(`${id}/aiLive`)).length, 0, 'cards are deleted with the meeting');
  const gone = await call('A', 'POST', `/${id}/ai/live/answer`, candidate());
  assert.equal(gone.status, 404);
  assert.equal(calls.length, 1);
});

test('LIVE-06: a meeting deleted while answering is not written back', async () => {
  const id = await liveMeeting();
  let open; script = { chunks: ['ANSWER\n', 'Later.'], gate: new Promise((r) => { open = r; }) };
  const pending = call('A', 'POST', `/${id}/ai/live/answer`, candidate());
  await new Promise((r) => setTimeout(r, 50));
  await call('A', 'DELETE', `/${id}`);
  open();
  const r = await pending;
  assert.equal(r.events.at(-1).event, 'error');
  assert.equal(r.events.at(-1).data.code, 'not_found');
  assert.equal([...db.store.keys()].filter((k) => k.startsWith(`meetings/${id}`)).length, 0);
});

test('LIVE-07: provider timeout and interruption: before a decision no card, after it a retryable error', async () => {
  const id = await liveMeeting();
  script = { chunks: [], hangBefore: true };
  const t = await call('A', 'POST', `/${id}/ai/live/answer`, candidate());
  assert.deepEqual(t.events.map((e) => e.event), ['error']);
  assert.equal(t.events[0].data.code, 'ai_timeout');
  assert.equal(t.events[0].data.shown, false);
  assert.equal(db.store.get(`meetings/${id}/aiLive/m2_a3`), undefined, 'nothing persisted, so a later delivery can try again');

  script = { chunks: ['ANSWER\nPartial'], hangAfter: true };
  const cut = await call('A', 'POST', `/${id}/ai/live/answer`, candidate());
  assert.equal(cut.events[0].event, 'card');
  assert.equal(cut.events.at(-1).data.code, 'ai_timeout');
  assert.equal(cut.events.at(-1).data.shown, true);
  assert.equal(db.store.get(`meetings/${id}/aiLive/m2_a3`).status, 'error');

  const redelivered = await call('A', 'POST', `/${id}/ai/live/answer`, candidate());
  assert.equal(redelivered.body.status, 'exists', 'a failed answer is not retried by a re-delivery');
  script = { chunks: ['ANSWER\nFebruary is safer.\nSOURCE_IDS: L2'] };
  const retried = await call('A', 'POST', `/${id}/ai/live/answer`, candidate(LINES[2], { retry: true }));
  assert.equal(retried.events.at(-1).data.status, 'answered');
  assert.equal(db.store.get(`meetings/${id}/aiLive/m2_a3`).attempts, 2, 'the timed-out claim before a decision was released');

  // Provider errors map to stable codes; transcript saving is a different route and unaffected.
  script = { chunks: [], throwError: new Anthropic.RateLimitError(429, { type: 'error' }, 'rate limited', new Headers()) };
  const busy = await call('A', 'POST', `/${id}/ai/live/answer`, { ...candidate({ id: 'm2_rl', speaker: 'P', text: 'what is next', ts: T0 + 90_000 }), context: [] });
  assert.equal(busy.events[0].data.code, 'ai_busy');
  const save = await call('A', 'POST', `/${id}/segments`, { segments: [{ messageId: 'm2_more', text: 'still saving', ts: T0 + 99_000 }] });
  assert.equal(save.status, 200);
});

test('LIVE-08: refusal is an error, not an answer; unknown routes are not "meeting not found"', async () => {
  const id = await liveMeeting();
  script = { chunks: ['ANSWER\nSomething'], stopReason: 'refusal' };
  const r = await call('A', 'POST', `/${id}/ai/live/answer`, candidate());
  assert.equal(r.events.at(-1).data.code, 'ai_declined');
  const missing = await call('A', 'POST', `/${id}/ai/nope`, {});
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'route_not_found');
});

test('LIVE-09: without a provider the route says so; invalid bodies are rejected', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { uid: 'A' }; next(); });
  app.use('/v1/meetings/:id/ai', createAiRouter({ db, FieldValue, FieldPath, anthropic: null }));
  app.use(errorHandler);
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const id = await liveMeeting('A');
  const res = await fetch(`http://127.0.0.1:${s.address().port}/v1/meetings/${id}/ai/live/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(candidate()) });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'ai_unavailable');
  await new Promise((r) => s.close(r));
  const bad = await call('A', 'POST', `/${id}/ai/live/answer`, { ...candidate(), questionId: '../x' });
  assert.equal(bad.status, 400);
});

// LIVE-DET-* (question detection in the Meet tab) and LIVE-E2E-* (Meet tab -> worker -> fake
// backend -> session storage), using the real extension files. No network, browser or account
// data is involved; the backend's own behaviour is covered in backend/test/aiLive.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowser, runClassic, settle, deferred, json, loadApiClient } from './harness.mjs';

// ---------------------------------------------------------------- detector (manual clock)

function detector(opts = {}) {
  let t = 1_000_000;
  const timers = new Map();
  let n = 0;
  const out = [];
  const ctx = runClassic(['sync/live-detect.js'], {});
  const d = ctx.MeetMemoLiveDetect.createDetector({
    onCandidate: (c) => out.push(c),
    now: () => t,
    setTimer: (f, ms) => { const id = ++n; timers.set(id, { f, at: t + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    ...opts,
  });
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      t = next[1].at;
      next[1].f();
    }
    t = end;
  };
  const say = (sourceId, text, speaker = 'Priya', extra = {}) => d.observe({ sourceId, text, speaker, ts: t, ...extra });
  return { d, out, advance, say, lib: ctx.MeetMemoLiveDetect };
}

test('LIVE-DET-01: a question settles after a quiet window; revisions reset the timer', () => {
  const { out, advance, say } = detector();
  say('c1', 'how would our');
  advance(500);
  say('c1', 'how would our business constraints');
  advance(500);
  assert.equal(out.length, 0, 'still being spoken');
  say('c1', 'how would our business constraints affect this rollout');
  advance(700);
  assert.equal(out.length, 0);
  advance(100);
  assert.equal(out.length, 1);
  assert.equal(out[0].sourceId, 'c1');
  assert.equal(out[0].text, 'how would our business constraints affect this rollout');
  assert.equal(out[0].speaker, 'Priya');
  advance(10_000);
  assert.equal(out.length, 1, 'settles once');
});

test('LIVE-DET-02: no punctuation needed; small talk and audio checks never leave the tab', () => {
  const { out, advance, say, lib } = detector();
  say('p', 'how would you define a Python list', 'Dev');
  advance(800);
  assert.equal(out.length, 1);
  for (const [i, text] of ['How was your day?', 'Can you hear me?', 'hi everyone', 'is my audio okay', 'We ship on Monday.', 'okay'].entries()) {
    say(`s${i}`, text, `Speaker ${i}`);
    advance(800);
  }
  assert.equal(out.length, 1);
  assert.equal(lib.classify('so what do you do'), 'question', 'the model decides casual vs. role-clarification');
  assert.equal(lib.classify('can you hear me ok so how would this affect churn'), 'question', 'a real question after an audio check is kept');
});

test('LIVE-DET-03: an unfinished caption waits for completion; a speaker change settles at once', () => {
  const { out, advance, say } = detector();
  say('u1', 'what is the plan for the');
  advance(800);
  assert.equal(out.length, 0, 'ends mid-phrase: extra wait');
  say('u1', 'what is the plan for the EU launch');
  advance(800);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'what is the plan for the EU launch');

  say('v1', 'should we delay the launch', 'Marcus');
  say('v2', 'I think we can keep the date', 'Priya'); // another speaker: Marcus is done
  assert.equal(out.length, 2);
  assert.equal(out[1].speaker, 'Marcus');
});

test('LIVE-DET-04: same-speaker fragments coalesce; context and identity come from the source', () => {
  const { out, advance, say } = detector();
  say('a', 'We are moving billing to the new provider in January.', 'Priya');
  advance(800);
  say('b', 'Finance wants no changes before Q1 close.', 'Marcus');
  say('c', 'so given all that', 'Priya');
  say('d', 'how would our business constraints affect this rollout', 'Priya');
  advance(800);
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.sourceId, 'd', 'the fragment that carries the question');
  assert.equal(c.text, 'so given all that how would our business constraints affect this rollout');
  assert.deepEqual(Array.from(c.context, (l) => l.sourceId), ['a', 'b', 'c', 'd']);
  assert.equal(c.context[1].speaker, 'Marcus');
});

test('LIVE-DET-05: replayed history is context only; an emitted caption re-emits only after it grows', () => {
  const { out, advance, say } = detector();
  say('h1', 'what is the budget for this quarter', 'Ada', { history: true });
  advance(5000);
  assert.equal(out.length, 0, 'replayed captions never trigger');
  say('q', 'what is the rollback plan');
  advance(800);
  say('q', 'what is the rollback plan ok'); // a minor revision
  advance(800);
  assert.equal(out.length, 1);
  say('q', 'what is the rollback plan if the migration fails halfway');
  advance(800);
  assert.equal(out.length, 2, 'grew by several words: checked again (the backend keeps one card)');
  assert.equal(out[1].sourceId, 'q');
});

test('LIVE-DET-06: pause drops pending work', () => {
  let paused = false;
  const { d, out, advance, say } = detector({ isPaused: () => paused });
  say('x', 'should we ship on Friday');
  paused = true;
  advance(800);
  assert.equal(out.length, 0);
  paused = false;
  d.reset();
  advance(5000);
  assert.equal(out.length, 0);
});

// ---------------------------------------------------------------- end to end

function sse(events, { hold } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(c) {
      for (const [i, [e, d]] of events.entries()) {
        if (hold && i === hold.at) await hold.promise;
        c.enqueue(enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
      }
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

// Meetings, segments and the live answer endpoint. `answer(req)` scripts the AI response.
function backend() {
  const meetings = new Map();
  const st = { n: 0, requests: [], answer: null, aiDown: false };
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    const uid = (opts.headers?.Authorization || '').replace('Bearer tok-', '');
    st.requests.push({ method: opts.method || 'GET', path: u.pathname, body, uid, signal: opts.signal });
    if (u.pathname === '/healthz') return json(200, st.health ?? { ok: true, features: ['ai-ask', 'ai-live'] });
    if (u.pathname.startsWith('/v1/auth/')) return json(200, { uid: 'A', idToken: 'tok-A', refreshToken: 'r-A', expiresIn: 3600 });
    if (!uid) return json(401, { error: 'unauthenticated' });
    if (u.pathname === '/v1/meetings' && opts.method === 'POST') {
      const id = `meeting-${++st.n}`;
      meetings.set(id, { ownerId: uid, segments: new Map() });
      return json(201, { id });
    }
    const m = u.pathname.match(/^\/v1\/meetings\/([^/]+)(\/.*)?$/);
    const mt = m && meetings.get(decodeURIComponent(m[1]));
    const own = mt && mt.ownerId === uid;
    if (m && m[2] === '/segments' && opts.method === 'POST') {
      if (!own) return json(404, { error: 'not_found', message: 'Meeting not found' });
      for (const s of body.segments) mt.segments.set(s.messageId, s);
      return json(200, { written: body.segments.length, stale: 0 });
    }
    if (m && m[2] === '/ai/live/answer') {
      if (st.aiDown) throw new TypeError('fetch failed');
      if (st.answer) return st.answer({ body, uid, own, signal: opts.signal });
      if (!own) return json(404, { error: 'not_found', message: 'Meeting not found' });
      return sse([['card', { questionId: body.questionId }], ['delta', { text: 'Answer.' }], ['sources', { ids: [] }], ['done', { status: 'answered' }]]);
    }
    if (m && m[2] === '/ai/live' && !opts.method) return own ? json(200, { enabled: st.aiEnabled ?? true, model: 'm', cards: [] }) : json(404, { error: 'not_found', message: 'Meeting not found' });
    if (m && !m[2]) return own ? json(200, { id: m[1], ownerId: uid }) : json(404, { error: 'not_found', message: 'Meeting not found' });
    throw new Error(`unexpected ${opts.method} ${u.pathname}`);
  };
  return { meetings, st, fetchImpl, ai: () => st.requests.filter((r) => r.path.endsWith('/ai/live/answer')) };
}

const WORKER_FILES = ['meetmemo.config.js', 'extension-auth/session.js', 'extension-auth/sessionAuthority.js', 'sync/segment-id.js', 'sync/worker.js', 'sync/live-worker.js'];
const WEB = { AbortController, TextDecoder, ReadableStream, Response, Headers, Intl };

function startWorker(browser, be) {
  return runClassic(WORKER_FILES, { chrome: browser.chromeFor({ url: 'chrome-extension://ext/service-worker.js' }), fetch: be.fetchImpl, ...WEB });
}
const signIn = (w, uid) => w.MeetMemoSync.authority.commitLogin({ uid, email: `${uid.toLowerCase()}@x.test`, idToken: `tok-${uid}`, refreshToken: `r-${uid}`, expiresIn: 3600 });

function meetTab(browser, { code = 'abc-defg-hij', sessionId = 'tab-1' } = {}) {
  const handlers = {};
  let interval;
  const ss = new Map();
  runClassic(['extension-auth/session.js', 'extension-auth/localBridge.js', 'extension-auth/links.js', 'sync/live-detect.js', 'sync/content.js'], {
    chrome: browser.chromeFor({ url: `https://meet.google.com/${code}`, tab: { id: 7, index: 2, windowId: 1 } }),
    location: { pathname: `/${code}` },
    sessionStorage: { getItem: (k) => ss.get(k) ?? null, setItem: (k, v) => ss.set(k, v) },
    crypto: { randomUUID: () => sessionId, subtle: globalThis.crypto.subtle },
    document: { documentElement: { addEventListener: (n, f) => { handlers[n] = f; } } },
    addEventListener: (n, f) => { handlers[n] = f; },
    setInterval: (f) => { interval = f; return 1; },
    clearInterval() {},
  });
  return {
    speak: (id, text, version = 1, deviceName = 'Priya') => handlers['MeetMemo-message']({ detail: { type: 'speech', messages: [{ messageId: id, text, messageVersion: version, deviceName }] } }),
    flush: () => interval(),
  };
}

async function waitFor(cond, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 15)); }
  return false;
}

// Signed-in worker + tab whose meeting already exists (as when the live view is open).
async function liveSetup({ autoAnswer = true } = {}) {
  const browser = createBrowser();
  const be = backend();
  const worker = startWorker(browser, be);
  await signIn(worker, 'A');
  await new Promise((r) => setTimeout(r, 3100)); // past content.js's start-up replay window
  const tab = meetTab(browser);
  tab.speak('cap/1', 'We plan to roll out the new billing flow in January.', 1, 'Marcus');
  tab.flush();
  await waitFor(() => be.meetings.size === 1);
  const meetingId = [...be.meetings.keys()][0];
  if (autoAnswer) await browser.local.set({ [`meetmemo_autoanswer:A:${meetingId}`]: { on: true, at: Date.now() - 10 } });
  const seg = (sourceId) => worker.MeetMemoSegmentId.segmentDocIdV2(sourceId);
  const cards = () => browser.session.data.get(`meetmemo_live:A:${meetingId}`)?.cards || {};
  return { browser, be, worker, tab, meetingId, seg, cards };
}

test('LIVE-E2E-01: Auto-answer off sends nothing; on, a settled question streams into a card', async () => {
  const s = await liveSetup({ autoAnswer: false });
  s.tab.speak('cap/2', 'how would our business constraints affect this rollout', 1, 'Priya');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(s.be.ai().length, 0, 'off by default: no AI request');

  await s.browser.local.set({ [`meetmemo_autoanswer:A:${s.meetingId}`]: { on: true, at: Date.now() } });
  const qid = await s.seg('cap/3');
  s.be.st.answer = ({ body }) => sse([
    ['card', { questionId: body.questionId }],
    ['delta', { text: 'A January rollout overlaps the Q1 freeze. ' }],
    ['delta', { text: 'Consider February.' }],
    ['sources', { ids: [body.context[0].id] }],
    ['done', { status: 'answered' }],
  ]);
  s.tab.speak('cap/3', 'how would our business constraints affect this rollout', 1, 'Priya');
  assert.ok(await waitFor(() => s.cards()[qid]?.status === 'answered'), 'card answered');
  const req = s.be.ai()[0];
  assert.equal(req.uid, 'A');
  assert.equal(req.path, `/v1/meetings/${s.meetingId}/ai/live/answer`, 'canonical backend meeting id, not the room code or tab session');
  assert.equal(req.body.questionId, qid, 'stable segment id of the question line');
  assert.deepEqual(req.body.question, { text: 'how would our business constraints affect this rollout', speaker: 'Priya', ts: req.body.question.ts });
  assert.ok(req.body.context.length >= 2 && req.body.context.length <= 12, 'bounded recent context');
  assert.equal(req.body.context[0].id, await s.seg('cap/1'));
  const card = s.cards()[qid];
  assert.equal(card.answer, 'A January rollout overlaps the Q1 freeze. Consider February.');
  assert.deepEqual(card.sources, [await s.seg('cap/1')]);
  assert.ok(card.timings.cardAt >= card.timings.settledAt && card.timings.firstTextAt >= card.timings.cardAt);
});

test('LIVE-E2E-02: small talk is never sent; duplicates, re-deliveries and restarts do not replay', async () => {
  const s = await liveSetup();
  s.tab.speak('t/1', 'Can you hear me?', 1, 'Sam');
  s.tab.speak('t/2', 'How was your day?', 1, 'Ada');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(s.be.ai().length, 0);

  s.tab.speak('q/1', 'what is the rollback plan if the migration fails', 1, 'Priya');
  const qid = await s.seg('q/1');
  assert.ok(await waitFor(() => s.cards()[qid]?.status === 'answered'));
  s.tab.speak('q/1', 'what is the rollback plan if the migration fails', 1, 'Priya'); // duplicate event
  const live = s.worker.MeetMemoSync.live;
  const meeting = { sessionId: 'tab-1', platform: 'googlemeet', meetingCode: 'abc-defg-hij', title: 't' };
  const cand = { sourceId: 'q/1', text: 'what is the rollback plan if the migration fails', speaker: 'Priya', ts: Date.now(), context: [] };
  await live.handleCandidate({ tab: 'tab-1', meeting, candidate: cand }); // re-delivery
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(s.be.ai().length, 1);

  // A restarted worker reads the same session state and does not ask again.
  const again = s.worker.MeetMemoLive.createLiveEngine({
    storage: s.browser.local, sessionStorage: s.browser.session, authority: s.worker.MeetMemoSync.authority,
    sync: s.worker.MeetMemoSync.engine, baseUrl: 'http://x', segmentDocId: s.worker.MeetMemoSegmentId.segmentDocId, fetchImpl: s.be.fetchImpl,
  });
  await again.recover();
  await again.handleCandidate({ tab: 'tab-1', meeting, candidate: cand });
  await settle(30);
  assert.equal(s.be.ai().length, 1);
});

test('LIVE-E2E-03: changing accounts mid-answer aborts it; nothing streams into the new account', async () => {
  const s = await liveSetup();
  const gate = deferred();
  let signal;
  s.be.st.answer = ({ body, signal: sg }) => { signal = sg; return sse([['card', { questionId: body.questionId }], ['delta', { text: 'Partial' }], ['delta', { text: ' more' }], ['done', { status: 'answered' }]], { hold: { at: 2, promise: gate.promise } }); };
  s.tab.speak('q/2', 'should we move the launch to February', 1, 'Priya');
  const qid = await s.seg('q/2');
  assert.ok(await waitFor(() => s.cards()[qid]?.answer === 'Partial'));
  await signIn(s.worker, 'B');
  assert.ok(await waitFor(() => signal?.aborted), 'request aborted on account change');
  gate.resolve();
  await settle(40);
  assert.notEqual(s.cards()[qid]?.answer, 'Partial more', 'no late events applied');
  assert.equal([...s.browser.session.data.keys()].filter((k) => k.startsWith('meetmemo_live:B:')).length, 0);
});

test('LIVE-E2E-04: turning Auto-answer off stops the answer in progress and new questions', async () => {
  const s = await liveSetup();
  const gate = deferred();
  let signal;
  s.be.st.answer = ({ body, signal: sg }) => { signal = sg; return sse([['card', { questionId: body.questionId }], ['delta', { text: 'Half' }], ['done', { status: 'answered' }]], { hold: { at: 2, promise: gate.promise } }); };
  s.tab.speak('q/3', 'what does this mean for support staffing', 1, 'Priya');
  const qid = await s.seg('q/3');
  assert.ok(await waitFor(() => s.cards()[qid]?.answer === 'Half'));
  await s.browser.local.set({ [`meetmemo_autoanswer:A:${s.meetingId}`]: { on: false, at: Date.now() } });
  assert.ok(await waitFor(() => signal?.aborted));
  gate.resolve();
  assert.ok(await waitFor(() => s.cards()[qid]?.status === 'error'));
  assert.equal(s.cards()[qid].errorCode, 'stopped', 'kept with Retry');
  s.tab.speak('q/4', 'how do we measure success for the rollout', 1, 'Marcus');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(s.be.ai().length, 1, 'no new requests while off');
});

test('LIVE-E2E-05: a deleted meeting stops AI work; an outdated server is not reported as a deleted meeting', async () => {
  const s = await liveSetup();
  s.be.st.answer = () => json(404, { error: 'not_found' }); // older backend: unknown route
  s.tab.speak('q/5', 'what is our fallback if the vendor slips', 1, 'Priya');
  const qid = await s.seg('q/5');
  assert.ok(await waitFor(() => s.cards()[qid]?.status === 'error'));
  assert.equal(s.cards()[qid].errorCode, 'route_not_found', 'meeting still exists: the route is missing');
  assert.ok(s.be.meetings.has(s.meetingId));

  s.be.meetings.delete(s.meetingId); // deleted elsewhere
  s.be.st.answer = () => json(404, { error: 'not_found', message: 'Meeting not found' });
  s.tab.speak('q/6', 'who owns the migration checklist', 1, 'Marcus');
  assert.ok(await waitFor(() => !s.browser.session.data.has(`meetmemo_live:A:${s.meetingId}`)), 'cards dropped');
  assert.equal(s.browser.local.data.has(`meetmemo_autoanswer:A:${s.meetingId}`), false, 'setting dropped');
  const before = s.be.ai().length;
  s.tab.speak('q/7', 'what is the timeline for the EU launch', 1, 'Priya');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(s.be.ai().length, before, 'no AI for the deleted meeting (or the fresh one, which starts off)');
});

test('LIVE-E2E-06: AI failures leave transcript saving working', async () => {
  const s = await liveSetup();
  s.be.st.aiDown = true;
  s.tab.speak('q/8', 'how would this affect our churn numbers', 1, 'Priya');
  const qid = await s.seg('q/8');
  assert.ok(await waitFor(() => s.cards()[qid]?.status === 'error'));
  assert.equal(s.cards()[qid].errorCode, 'network');
  s.tab.flush();
  assert.ok(await waitFor(() => [...s.be.meetings.get(s.meetingId).segments.values()].some((x) => x.text === 'how would this affect our churn numbers')), 'the question line itself was saved');

  // Retry from the panel re-sends the stored question once the server is back.
  s.be.st.aiDown = false;
  await s.worker.MeetMemoSync.live.retry({ meetingId: s.meetingId, questionId: qid });
  assert.ok(await waitFor(() => s.cards()[qid]?.status === 'answered'));
  assert.equal(s.be.ai().at(-1).body.retry, true);
});

test('LIVE-CLIENT-01: an outdated server 404 is route_not_found, a real one stays not_found', async () => {
  const createApiClient = loadApiClient();
  const mk = (status, body) => createApiClient({ baseUrl: 'http://api.test', authProvider: { getAuth: async () => ({ idToken: 't', user: { uid: 'A' } }) }, fetchImpl: async () => json(status, body) });
  await assert.rejects(mk(404, { error: 'not_found' }).listLiveCards('m1'), (e) => e.code === 'route_not_found');
  await assert.rejects(mk(404, { error: 'route_not_found', message: 'x' }).listLiveCards('m1'), (e) => e.code === 'route_not_found');
  await assert.rejects(mk(404, { error: 'not_found', message: 'Meeting not found' }).listLiveCards('m1'), (e) => e.code === 'not_found');
});

// ---------------------------------------------------------------- Claude in the Meet panel

// The Meet tab's side of the "meetmemo-claude" port (what sync/claude-dock.js sends and gets).
function claudeDock(s, { sessionId = 'tab-1', code = 'abc-defg-hij' } = {}) {
  const port = s.browser.chromeFor({ url: `https://meet.google.com/${code}`, tab: { id: 7 } }).runtime.connect({ name: 'meetmemo-claude' });
  const states = [];
  port.onMessage.addListener((m) => { if (m.type === 'state') states.push(m); });
  port.postMessage({ type: 'watch', meeting: { sessionId, platform: 'googlemeet', meetingCode: code, title: 't' } });
  return { port, states, last: () => states.at(-1), set: (on) => port.postMessage({ type: 'set', on }) };
}

test('LIVE-DOCK-01: the Claude switch in the Meet panel turns answers on and streams them into the panel', async () => {
  const s = await liveSetup({ autoAnswer: false });
  const d = claudeDock(s);
  assert.ok(await waitFor(() => d.last()?.meetingId === s.meetingId), 'state for the canonical meeting');
  assert.equal(d.last().signedIn, true);
  assert.equal(d.last().on, false, 'off until the user turns it on');
  assert.equal(d.last().serverOutdated, false);

  d.set(true);
  assert.ok(await waitFor(() => d.last()?.on === true));
  assert.equal(s.browser.local.data.get('meetmemo_claude:A').on, true, 'account-wide switch');
  assert.equal(s.browser.local.data.get(`meetmemo_autoanswer:A:${s.meetingId}`).on, true, 'this meeting, same state as the live view');
  assert.ok(await waitFor(() => d.last()?.enabled === true), 'server reports Claude is configured');

  s.tab.speak('cap/5', 'what is the rollback plan if the migration fails', 1, 'Priya');
  const qid = await s.seg('cap/5');
  assert.ok(await waitFor(() => d.last()?.cards?.[0]?.status === 'answered'), 'answer reaches the panel without a click');
  assert.equal(d.last().cards[0].questionId, qid);
  assert.equal(d.last().cards[0].answer, 'Answer.');
  assert.equal(d.last().cards[0].question.speaker, 'Priya');

  d.set(false);
  assert.ok(await waitFor(() => d.last()?.on === false));
  assert.equal(s.browser.local.data.get(`meetmemo_autoanswer:A:${s.meetingId}`).on, false);
  const before = s.be.ai().length;
  s.tab.speak('cap/6', 'should we move the launch to February', 1, 'Priya');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(s.be.ai().length, before, 'off: nothing is sent');
});

test('LIVE-DOCK-02: a later meeting follows the account-wide Claude switch with no click', async () => {
  const s = await liveSetup({ autoAnswer: false });
  await s.browser.local.set({ 'meetmemo_claude:A': { on: true, at: Date.now() } });
  s.tab.speak('cap/7', 'should we move the launch to February', 1, 'Priya');
  const qid = await s.seg('cap/7');
  assert.ok(await waitFor(() => s.cards()[qid]?.status === 'answered'), 'answered automatically');
  assert.equal(s.browser.local.data.get(`meetmemo_autoanswer:A:${s.meetingId}`).on, true, 'recorded for this meeting');

  // A meeting turned off on its own stays off even while the account-wide switch is on.
  await s.browser.local.set({ [`meetmemo_autoanswer:A:${s.meetingId}`]: { on: false, at: Date.now() } });
  const before = s.be.ai().length;
  s.tab.speak('cap/8', 'what is the budget for this quarter', 1, 'Priya');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(s.be.ai().length, before);
});

test('LIVE-DOCK-03: an outdated backend is reported as outdated, not as a failed question', async () => {
  const s = await liveSetup({ autoAnswer: false });
  s.be.st.health = { ok: true }; // a deployment from before the AI routes
  const d = claudeDock(s);
  assert.ok(await waitFor(() => d.last()?.meetingId === s.meetingId));
  assert.equal(d.last().serverOutdated, true);
});

test('LIVE-DOCK-04: signed out, the panel is told so and nothing is written', async () => {
  const browser = createBrowser();
  const be = backend();
  startWorker(browser, be);
  const d = claudeDock({ browser });
  assert.ok(await waitFor(() => d.last()));
  assert.equal(d.last().signedIn, false);
  d.set(true);
  await settle(30);
  assert.equal([...browser.local.data.keys()].filter((k) => k.startsWith('meetmemo_claude:') || k.startsWith('meetmemo_autoanswer:')).length, 0);
});

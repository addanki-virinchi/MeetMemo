// SYNC-01..04, UI-01, Pause: transcript revisions, ids, durable delivery, mappings, status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowser, runClassic, settle, deferred, json } from './harness.mjs';

// ---------------------------------------------------------------- fake backend

function meetingsBackend() {
  const meetings = new Map(); // id -> { ownerId, segments: Map(docId -> seg) }
  const st = { n: 0, down: false, holdSegments: null, holdCreate: null, requests: [] };
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    st.requests.push({ method: opts.method || 'GET', path: u.pathname, body });
    if (st.down) throw new TypeError('fetch failed');
    if (u.pathname.startsWith('/v1/auth/')) {
      if (u.pathname.endsWith('/refresh')) { const uid = body.refreshToken.slice(2); return json(200, { uid, idToken: `tok-${uid}`, refreshToken: body.refreshToken, expiresIn: 3600 }); }
      const uid = body.email.split('@')[0].toUpperCase();
      return json(200, { uid, email: body.email, idToken: `tok-${uid}`, refreshToken: `r-${uid}`, expiresIn: 3600 });
    }
    const uid = (opts.headers?.Authorization || '').replace('Bearer tok-', '');
    if (!uid) return json(401, { error: 'unauthenticated' });
    if (u.pathname === '/v1/meetings' && opts.method === 'POST') {
      if (st.holdCreate) await st.holdCreate.promise;
      const id = `meeting-${++st.n}`;
      meetings.set(id, { ownerId: uid, body, segments: new Map() });
      return json(201, { id });
    }
    const m = u.pathname.match(/^\/v1\/meetings\/([^/]+)\/segments$/);
    if (m && opts.method === 'POST') {
      if (st.holdSegments) await st.holdSegments.promise;
      const mt = meetings.get(decodeURIComponent(m[1]));
      if (!mt || mt.ownerId !== uid) return json(404, { error: 'not_found' });
      let written = 0; let stale = 0;
      for (const s of body.segments) {
        const prev = mt.segments.get(s.messageId);
        if (prev && Number.isInteger(prev.rev) && Number.isInteger(s.rev) && s.rev < prev.rev) { stale += 1; continue; }
        mt.segments.set(s.messageId, s); written += 1;
      }
      return json(200, { written, stale });
    }
    throw new Error(`unexpected ${opts.method} ${u.pathname}`);
  };
  return { meetings, st, fetchImpl, all: () => [...meetings.values()].flatMap((m) => [...m.segments.values()]) };
}

const WORKER_FILES = ['meetmemo.config.js', 'extension-auth/session.js', 'extension-auth/sessionAuthority.js', 'sync/segment-id.js', 'sync/worker.js'];

function startWorker(browser, backend) {
  return runClassic(WORKER_FILES, { chrome: browser.chromeFor({ url: 'chrome-extension://ext/service-worker.js' }), fetch: backend.fetchImpl });
}

async function signIn(worker, uid) {
  return worker.MeetMemoSync.authority.commitLogin({ uid, email: `${uid.toLowerCase()}@x.test`, idToken: `tok-${uid}`, refreshToken: `r-${uid}`, expiresIn: 3600 });
}

// A Google Meet tab running the real sync/content.js.
function meetTab(browser, { code = 'abc-defg-hij', sessionId = 'tab-1', paused = () => false } = {}) {
  const handlers = {};
  let interval;
  const ss = new Map();
  const ctx = runClassic(['extension-auth/session.js', 'extension-auth/localBridge.js', 'extension-auth/links.js', 'sync/platforms.js', 'sync/content.js'], {
    chrome: browser.chromeFor({ url: `https://meet.google.com/${code}`, tab: { id: 7, index: 2, windowId: 1 } }),
    location: { host: 'meet.google.com', pathname: `/${code}` },
    sessionStorage: { getItem: (k) => ss.get(k) ?? null, setItem: (k, v) => ss.set(k, v) },
    crypto: { randomUUID: () => sessionId, subtle: globalThis.crypto.subtle },
    document: { documentElement: { addEventListener: (n, f) => { handlers[n] = f; } } },
    addEventListener: (n, f) => { handlers[n] = f; },
    setInterval: (f) => { interval = f; return 1; },
    clearInterval() {},
  });
  ctx.MEETMEMO_PANEL = { currentTranscript: () => ({ isPaused: paused() }) };
  return {
    ctx,
    speak: (id, text, version = 1) => handlers['MeetMemo-message']({ detail: { type: 'speech', messages: [{ messageId: id, text, messageVersion: version, deviceId: 'd1' }] } }),
    device: (deviceId, deviceName) => handlers['MeetMemo-message']({ detail: { type: 'deviceinfo', deviceId, deviceName } }),
    flush: () => interval(),
    hide: () => handlers.pagehide(),
  };
}

const texts = (backend) => backend.all().map((s) => s.text).sort();
const status = (browser) => browser.local.data.get('meetmemo_sync_status');
const queueKeys = (browser) => [...browser.local.data.keys()].filter((k) => k.startsWith('meetmemo_q:'));

// ---------------------------------------------------------------- SYNC-01 revisions

test('SYNC-01: version 2 -> acknowledged -> late version 1 never overwrites', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  const tab = meetTab(browser);
  tab.speak('1/@a', 'new', 2); tab.flush(); await settle(60);
  assert.deepEqual(texts(backend), ['new']);
  tab.speak('1/@a', 'old', 1); tab.flush(); await settle(60);
  assert.deepEqual(texts(backend), ['new']);
  assert.equal(backend.st.requests.filter((r) => r.path.endsWith('/segments')).length, 1, 'stale revision is not even sent');
});

test('SYNC-01: equal revision with identical text is a duplicate; with new text it is accepted', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  const tab = meetTab(browser);
  tab.speak('m', 'hello', 3); tab.flush(); await settle(60);
  tab.speak('m', 'hello', 3); tab.flush(); await settle(60);
  assert.equal(backend.st.requests.filter((r) => r.path.endsWith('/segments')).length, 1);
  tab.speak('m', 'hello world', 3); tab.flush(); await settle(60);
  assert.deepEqual(texts(backend), ['hello world']);
});

test('SYNC-01: edits arriving while an upload is in flight are preserved', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  const tab = meetTab(browser);
  backend.st.holdSegments = deferred();
  tab.speak('m', 'v1', 1); tab.flush(); await settle(40);
  tab.speak('m', 'v2', 2); tab.flush(); await settle(40); // reaches the durable queue during the held upload
  const hold = backend.st.holdSegments; backend.st.holdSegments = null; hold.resolve();
  await settle(120);
  assert.deepEqual(texts(backend), ['v2']);
  assert.deepEqual(queueKeys(browser), []);
});

test('SYNC-01: backend keeps the newest revision when an old request lands late (retry after lost ack)', async () => {
  // Server-side rule covered in backend/test/meetings.test.js; here the client resends the
  // same revision after a lost receipt and the result is unchanged.
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  const tab = meetTab(browser);
  tab.speak('m', 'once', 1); tab.flush(); await settle(60);
  tab.hide(); await settle(60); // duplicate best-effort send
  assert.deepEqual(texts(backend), ['once']);
});

// ---------------------------------------------------------------- SYNC-02 ids

test('SYNC-02: slash/underscore, Unicode and long shared-prefix ids stay distinct', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  const tab = meetTab(browser);
  const prefix = 'p'.repeat(300);
  const ids = ['a/b', 'a_b', 'ünï/çødé', 'ünï_çødé', `${prefix}1`, `${prefix}2`, '日本語', '1/@a'];
  ids.forEach((id, i) => tab.speak(id, `t${i}`));
  tab.flush(); await settle(80);
  const segs = backend.all();
  assert.equal(segs.length, ids.length);
  assert.equal(new Set(segs.map((s) => s.messageId)).size, ids.length);
  for (const s of segs) {
    assert.match(s.messageId, /^m2_[0-9a-f]{32}$/);
    assert.ok(ids.includes(s.sourceId) || s.sourceId === `${prefix}1`.slice(0, 1000));
  }
  // Deterministic: the same source id always maps to the same document.
  const { segmentDocIdV2 } = worker.MeetMemoSegmentId;
  assert.equal(await segmentDocIdV2('a/b'), await segmentDocIdV2('a/b'));
  assert.notEqual(await segmentDocIdV2('a/b'), await segmentDocIdV2('a_b'));
});

test('SYNC-02: meetings mapped by the previous version keep legacy ids (no duplicates)', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  backend.meetings.set('old-meeting', { ownerId: 'A', segments: new Map([['1_@a', { messageId: '1_@a', text: 'before upgrade' }]]) });
  await browser.session.set({ meetmemo_sync_meetings: { 'tab-1': { meetingId: 'old-meeting', uid: 'A' } } });
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  await settle(20);
  const tab = meetTab(browser);
  tab.speak('1/@a', 'after upgrade', 2); tab.flush(); await settle(80);
  const segs = [...backend.meetings.get('old-meeting').segments.values()];
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, 'after upgrade');
  assert.equal(backend.meetings.size, 1, 'no new meeting created');
});

// ---------------------------------------------------------------- SYNC-03 durable delivery

test('SYNC-03: lines queued during an in-flight batch survive leaving the page', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  const tab = meetTab(browser);
  backend.st.holdSegments = deferred();
  tab.speak('1', 'first'); tab.flush(); await settle(40);
  tab.speak('2', 'last'); tab.flush(); await settle(40); // handed to the durable queue
  // The tab is gone now; only the worker and storage remain.
  const hold = backend.st.holdSegments; backend.st.holdSegments = null; hold.resolve();
  await settle(150);
  assert.deepEqual(texts(backend), ['first', 'last']);
});

test('SYNC-03: worker restart with queued lines and backend offline -> recovery, no duplicates', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  let worker = startWorker(browser, backend); await signIn(worker, 'A');
  const tab = meetTab(browser);
  await settle(20);
  backend.st.down = true;
  tab.speak('1', 'one'); tab.speak('2', 'two'); tab.flush(); await settle(80);
  assert.equal(queueKeys(browser).length, 1, 'received durably while backend is down');
  assert.equal(status(browser).meetings['tab-1'].state, 'error');
  // Worker terminated and restarted (new context, same storage); backend comes back.
  browser.connectListeners.clear(); browser.messageListeners.clear();
  backend.st.down = false;
  worker = startWorker(browser, backend);
  await settle(150);
  assert.deepEqual(texts(backend), ['one', 'two']);
  assert.equal(backend.all().length, 2);
  assert.deepEqual(queueKeys(browser), []);
  assert.equal(status(browser).meetings['tab-1'].state, 'saved');
});

test('SYNC-03: queue limit drops oldest lines and reports the loss', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  backend.st.down = true;
  const { MAX_QUEUE_LINES } = worker.MeetMemoSyncEngine;
  const engine = worker.MeetMemoSync.engine;
  const lines = Array.from({ length: MAX_QUEUE_LINES + 3 }, (_, i) => ({ sourceId: `id${i}`, rev: 0, text: `t${i}`, ts: i }));
  const r = await engine.receive({ meeting: { sessionId: 'tab-9', platform: 'googlemeet', meetingCode: 'abc-defg-hij', title: 't' }, lines });
  assert.equal(r.queued, MAX_QUEUE_LINES);
  assert.equal(r.dropped, 3);
  const q = browser.local.data.get('meetmemo_q:tab-9:A');
  assert.equal(q.lines.id0, undefined, 'oldest dropped');
  assert.ok(q.lines[`id${MAX_QUEUE_LINES + 2}`]);
});

test('SYNC-03: signed-out capture is held, then saved to the account that signs in', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend);
  const tab = meetTab(browser);
  tab.speak('1', 'before sign-in'); tab.flush(); await settle(60);
  assert.deepEqual(queueKeys(browser), ['meetmemo_q:tab-1:~anon']);
  await signIn(worker, 'A'); await settle(150);
  assert.deepEqual(texts(backend), ['before sign-in']);
  assert.equal([...backend.meetings.values()][0].ownerId, 'A');
});

test("SYNC-03: A's queued lines are never uploaded as B", async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  backend.st.down = true;
  const tab = meetTab(browser);
  tab.speak('1', "A's line"); tab.flush(); await settle(60);
  await worker.MeetMemoSync.authority.signOut();
  await signIn(worker, 'B');
  backend.st.down = false;
  tab.speak('2', "B's line"); tab.flush(); await settle(150);
  const owners = [...backend.meetings.values()].map((m) => [m.ownerId, [...m.segments.values()].map((s) => s.text)]);
  assert.deepEqual(owners, [['B', ["B's line"]]]);
  assert.ok(browser.local.data.has('meetmemo_q:tab-1:A'), "A's lines held for A");
  await worker.MeetMemoSync.authority.signOut(); await signIn(worker, 'A'); await settle(150);
  assert.deepEqual([...backend.meetings.values()].find((m) => m.ownerId === 'A') && [...[...backend.meetings.values()].find((m) => m.ownerId === 'A').segments.values()].map((s) => s.text), ["A's line"]);
});

// ---------------------------------------------------------------- SYNC-04 mappings

test('SYNC-04: two simultaneous first saves keep both mappings; later batches reuse them', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  const t1 = meetTab(browser, { sessionId: 'tab-1' });
  const t2 = meetTab(browser, { code: 'xyz-abcd-efg', sessionId: 'tab-2' });
  t1.speak('1', 'one'); t2.speak('1', 'two'); t1.flush(); t2.flush();
  await settle(120);
  assert.ok(browser.local.data.has('meetmemo_map:A:tab-1'));
  assert.ok(browser.local.data.has('meetmemo_map:A:tab-2'));
  assert.equal(backend.meetings.size, 2);
  t1.speak('2', 'one-b'); t2.speak('2', 'two-b'); t1.flush(); t2.flush();
  await settle(120);
  assert.equal(backend.meetings.size, 2, 'no fragmentation');
  const per = [...backend.meetings.values()].map((m) => m.segments.size).sort();
  assert.deepEqual(per, [2, 2]);
});

test('SYNC-04: deleting one mapping while another is created keeps the other', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  const engine = worker.MeetMemoSync.engine;
  const m1 = await engine.ensureMeeting('A', 'tab-1', { title: 't', platform: 'googlemeet' });
  backend.st.holdCreate = deferred();
  const creating = engine.ensureMeeting('A', 'tab-2', { title: 't', platform: 'googlemeet' });
  await settle(10);
  await engine.forgetMeeting('A', 'tab-1', m1.meetingId);
  backend.st.holdCreate.resolve();
  const m2 = await creating;
  assert.equal(browser.local.data.has('meetmemo_map:A:tab-1'), false);
  assert.equal(browser.local.data.get('meetmemo_map:A:tab-2').meetingId, m2.meetingId);
  // forgetMeeting only removes the mapping it was asked about.
  await engine.forgetMeeting('A', 'tab-2', 'some-other-id');
  assert.ok(browser.local.data.has('meetmemo_map:A:tab-2'));
});

test('SYNC-04: account switch during meeting creation never attaches it to the new account', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  const engine = worker.MeetMemoSync.engine;
  backend.st.holdCreate = deferred();
  const creating = engine.ensureMeeting('A', 'tab-1', { title: 't', platform: 'googlemeet' });
  await settle(10);
  await worker.MeetMemoSync.authority.signOut(); await signIn(worker, 'B');
  backend.st.holdCreate.resolve();
  await creating;
  assert.ok(browser.local.data.has('meetmemo_map:A:tab-1'));
  assert.equal(browser.local.data.has('meetmemo_map:B:tab-1'), false);
});

// ---------------------------------------------------------------- UI-01 status

test('UI-01: status is scoped to account + session and reset on identity change', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend);
  const a = await signIn(worker, 'A');
  const tab = meetTab(browser);
  tab.speak('1', 'hi'); tab.flush(); await settle(100);
  const st = status(browser);
  assert.equal(st.uid, 'A'); assert.equal(st.sid, a.sid);
  assert.equal(st.meetings['tab-1'].state, 'saved');
  await worker.MeetMemoSync.authority.signOut();
  assert.equal(status(browser), undefined, 'cleared on logout');
  const b = await signIn(worker, 'B');
  const S = worker.MeetMemoSession;
  assert.equal(S.statusFor(st, b), null, "A's old status is never rendered for B");
  // Re-login to the same account is a new session: old status is not shown either.
  assert.equal(S.statusFor(st, { ...a, sid: 'another' }), null);
});

test('UI-01: two concurrent meetings keep separate status entries', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  const t1 = meetTab(browser, { sessionId: 'tab-1' });
  const t2 = meetTab(browser, { code: 'xyz-abcd-efg', sessionId: 'tab-2' });
  t1.speak('1', 'a'); t2.speak('1', 'b'); t1.flush(); t2.flush(); await settle(150);
  const m = status(browser).meetings;
  assert.equal(m['tab-1'].meetingCode, 'abc-defg-hij');
  assert.equal(m['tab-2'].meetingCode, 'xyz-abcd-efg');
  assert.notEqual(m['tab-1'].meetingId, m['tab-2'].meetingId);
});

// ---------------------------------------------------------------- Pause

test('Pause: captions emitted while the panel is paused are not saved', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  let paused = false;
  const tab = meetTab(browser, { paused: () => paused });
  tab.speak('1', 'before pause'); tab.flush(); await settle(80);
  paused = true;
  tab.speak('2', 'while paused'); tab.flush(); await settle(80);
  paused = false;
  tab.speak('3', 'after resume'); tab.flush(); await settle(80);
  assert.deepEqual(texts(backend), ['after resume', 'before pause']);
});

test('speaker names are attached from device info', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  const tab = meetTab(browser);
  tab.device('d1', 'Ada');
  tab.speak('1', 'hello'); tab.flush(); await settle(80);
  assert.equal(backend.all()[0].speaker, 'Ada');
});

test('SYNC-05: one line the backend permanently rejects is isolated and dropped; the rest still save', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const real = backend.fetchImpl;
  backend.fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'POST' && /\/segments$/.test(url) && JSON.parse(opts.body).segments.some((s) => s.text === 'POISON')) {
      return json(400, { error: 'invalid_request', message: 'rejected' });
    }
    return real(url, opts);
  };
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  await settle(20);
  const tab = meetTab(browser);
  for (let i = 0; i < 6; i += 1) tab.speak(`1/@${i}`, i === 2 ? 'POISON' : `line ${i}`, 1);
  tab.flush(); await settle(300);
  const texts = backend.all().map((s) => s.text).sort();
  assert.deepEqual(texts, ['line 0', 'line 1', 'line 3', 'line 4', 'line 5']);
});

test('SYNC-06: a 401 from the backend forces one token refresh and the save is retried', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  const real = backend.fetchImpl; let rejected = false; let refreshes = 0;
  backend.fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/v1/auth/refresh')) refreshes += 1;
    if (opts.method === 'POST' && /\/segments$/.test(url) && !rejected) { rejected = true; return json(401, { error: 'unauthenticated' }); }
    return real(url, opts);
  };
  const worker = startWorker(browser, backend); await signIn(worker, 'A');
  await settle(20);
  const tab = meetTab(browser);
  tab.speak('1/@a', 'hello', 1); tab.flush(); await settle(200);
  assert.equal(refreshes, 1);
  assert.deepEqual(backend.all().map((s) => s.text), ['hello']);
});

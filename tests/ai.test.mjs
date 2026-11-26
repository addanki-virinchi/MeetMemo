// Ask MeetMemo AI on the extension side: the streaming API client and the in-meeting entry point.
// The panel's backend contract is covered in backend/test/ai.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowser, runClassic, loadApiClient, settle } from './harness.mjs';

const authProvider = (uid = 'A') => ({ getAuth: async () => ({ idToken: `tok-${uid}`, user: { uid } }) });

// A streamed response split at awkward places (inside an event, inside a JSON payload).
function sseResponse(chunks, status = 200) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function client(fetchImpl) {
  const createApiClient = loadApiClient({ TextDecoder, AbortController, ReadableStream, Response });
  return createApiClient({ baseUrl: 'http://api.test', authProvider: authProvider(), fetchImpl });
}

test('AI-CLIENT-01: askMeeting parses events split across chunks and ignores keep-alives', async () => {
  const seen = [];
  let request;
  const api = client(async (url, opts) => {
    request = { url, opts };
    return sseResponse([
      'event: meta\ndata: {"threadId":"t1","questionId":"q1","answerId":"a1","lineCount":3}\n\n: ping\n\nev',
      'ent: cite\ndata: {"index":0,"segmentId":"m2_x"}\n\nevent: delta\ndata: {"text":"Hi [[cite:0]]',
      '"}\n\nevent: done\ndata: {"answerId":"a1","status":"complete"}\n\n',
    ]);
  });
  await api.askMeeting('m 1', { question: 'q' }, { expectUid: 'A', onEvent: (e, d) => seen.push([e, d]) });
  assert.equal(request.url, 'http://api.test/v1/meetings/m%201/ai/ask');
  assert.equal(request.opts.method, 'POST');
  assert.equal(request.opts.headers.Authorization, 'Bearer tok-A');
  assert.deepEqual(JSON.parse(request.opts.body), { question: 'q' });
  assert.deepEqual(seen.map(([e]) => e), ['meta', 'cite', 'delta', 'done']);
  assert.equal(seen[2][1].text, 'Hi [[cite:0]]');
});

test('AI-CLIENT-02: errors before the stream keep the server code; a cut stream is reported', async () => {
  const limited = client(async () => new Response(JSON.stringify({ error: 'ai_rate_limited', message: 'slow down' }), { status: 429 }));
  await assert.rejects(limited.askMeeting('m1', { question: 'q' }), (e) => e.code === 'ai_rate_limited' && e.status === 429);

  const cut = client(async () => sseResponse(['event: delta\ndata: {"text":"Hal"}\n\n']));
  await assert.rejects(cut.askMeeting('m1', { question: 'q' }, { onEvent() {} }), (e) => e.code === 'stream_cut');

  const other = loadApiClient({ TextDecoder, AbortController })({ baseUrl: 'http://api.test', authProvider: authProvider('B'), fetchImpl: async () => { throw new Error('must not be called'); } });
  await assert.rejects(other.askMeeting('m1', { question: 'q' }, { expectUid: 'A' }), (e) => e.code === 'account_changed');
});

test('AI-CLIENT-03: stopping aborts the request', async () => {
  const ctrl = new AbortController();
  let fetchSignal;
  const api = client(async (url, opts) => new Promise((resolve, reject) => {
    fetchSignal = opts.signal;
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (opts.signal.aborted) fail(); else opts.signal.addEventListener('abort', fail); // like real fetch
  }));
  const pending = api.askMeeting('m1', { question: 'q' }, { signal: ctrl.signal });
  await settle(5); // request in flight
  assert.equal(fetchSignal.aborted, false);
  ctrl.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  assert.equal(fetchSignal.aborted, true);
});

test('AI-ROUTE-01: Ask MeetMemo AI in a meeting opens that transcript with the panel', async () => {
  const browser = createBrowser();
  const chromeApi = browser.chromeFor();
  const sent = [];
  chromeApi.runtime.sendMessage = async (m) => { sent.push(structuredClone(m)); };
  const calls = [];
  const ctx = runClassic(['extension-auth/links.js'], { chrome: chromeApi });
  ctx.MEETMEMO_SYNC = { openTranscript: (o) => calls.push({ ...o }) }; // provided by sync/content.js on Meet
  ctx.MEETMEMO_LINKS.signIn('ask-ai');
  await settle(5);
  assert.deepEqual(calls, [{ ask: true }]);
  assert.deepEqual(sent, [], 'no "unavailable" page when a meeting is open');
});

// Route tests for meetingsRouter.js against the in-memory Firestore fake.
// Run with: npm test (from backend/). No Firebase credentials or network are used.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMeetingsRouter } from '../src/routes/meetingsRouter.js';
import { errorHandler, notFound } from '../src/middleware/error.js';
import { createFakeFirestore, FieldValue, FieldPath } from './fakeFirestore.js';
import { decodeCursor, encodeCursor, parsePageLimit, isValidSegmentDocId } from '../src/lib/segments.js';

let server;
let base;
let db;

before(async () => {
  db = createFakeFirestore();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  // Test identity comes from a header; the real app uses requireAuth (Firebase ID tokens).
  app.use((req, res, next) => { req.user = { uid: req.get('x-test-uid') }; next(); });
  app.use('/v1/meetings', createMeetingsRouter({ db, FieldValue, FieldPath }));
  app.use(notFound);
  app.use(errorHandler);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

async function call(uid, method, path, body) {
  const res = await fetch(`${base}/v1/meetings${path}`, {
    method,
    headers: { 'x-test-uid': uid, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function newMeeting(uid = 'A') {
  const r = await call(uid, 'POST', '/', { title: 't', platform: 'googlemeet', segmentIdScheme: 2 });
  assert.equal(r.status, 201);
  return r.body.id;
}

async function readAll(uid, id, limit) {
  const items = [];
  let after = null;
  let pages = 0;
  do {
    const q = new URLSearchParams({ limit: String(limit) });
    if (after) q.set('after', after);
    const r = await call(uid, 'GET', `/${id}/segments?${q}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    items.push(...r.body.items);
    after = r.body.next;
    pages += 1;
  } while (after);
  return { items, pages };
}

test('1,001+ segments with equal timestamps page without gaps or duplicates', async () => {
  const id = await newMeeting();
  const total = 1003;
  const all = Array.from({ length: total }, (_, i) => ({
    messageId: `m2_${String(i).padStart(32, '0')}`,
    text: `line ${i}`,
    ts: 1000 + Math.floor(i / 7), // runs of 7 equal timestamps, including across page boundaries
  }));
  for (let i = 0; i < total; i += 400) {
    const r = await call('A', 'POST', `/${id}/segments`, { segments: all.slice(i, i + 400) });
    assert.equal(r.status, 200);
  }
  for (const limit of [1000, 7, 100]) {
    const { items, pages } = await readAll('A', id, limit);
    assert.equal(items.length, total, `limit ${limit}`);
    assert.equal(new Set(items.map((x) => x.id)).size, total, `no duplicates at limit ${limit}`);
    assert.equal(pages, Math.ceil(total / limit));
    const sorted = [...items].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    assert.deepEqual(items.map((x) => x.id), sorted.map((x) => x.id), 'stable (ts, id) order');
  }
});

test('exact page boundary does not report a phantom next page', async () => {
  const id = await newMeeting();
  const segs = Array.from({ length: 10 }, (_, i) => ({ messageId: `m2_${i}`, text: 'x', ts: 5 }));
  await call('A', 'POST', `/${id}/segments`, { segments: segs });
  const r = await call('A', 'GET', `/${id}/segments?limit=10`);
  assert.equal(r.body.items.length, 10);
  assert.equal(r.body.next, null);
});

test('every page enforces ownership, including with a valid cursor', async () => {
  const id = await newMeeting('A');
  await call('A', 'POST', `/${id}/segments`, { segments: [{ messageId: 'm2_a', text: 'secret', ts: 1 }, { messageId: 'm2_b', text: 'secret2', ts: 2 }] });
  const first = await call('A', 'GET', `/${id}/segments?limit=1`);
  assert.ok(first.body.next);
  assert.equal((await call('B', 'GET', `/${id}/segments?limit=1`)).status, 404);
  assert.equal((await call('B', 'GET', `/${id}/segments?limit=1&after=${first.body.next}`)).status, 404);
  assert.equal((await call('B', 'POST', `/${id}/segments`, { segments: [{ messageId: 'm2_c', text: 'x', ts: 3 }] })).status, 404);
});

test('invalid pagination input is rejected with 400', async () => {
  const id = await newMeeting();
  for (const q of ['limit=0', 'limit=1001', 'limit=abc', 'limit=-1', 'after=not-a-cursor', `after=${Buffer.from('[1]').toString('base64url')}`]) {
    assert.equal((await call('A', 'GET', `/${id}/segments?${q}`)).status, 400, q);
  }
});

test('older revision never replaces a newer stored revision; equal revision is an idempotent upsert', async () => {
  const id = await newMeeting();
  const seg = (text, rev) => ({ messageId: 'm2_x', sourceId: '1/@a', text, rev, ts: 1 });
  assert.deepEqual((await call('A', 'POST', `/${id}/segments`, { segments: [seg('v2', 2)] })).body, { written: 1, stale: 0 });
  assert.deepEqual((await call('A', 'POST', `/${id}/segments`, { segments: [seg('v1', 1)] })).body, { written: 0, stale: 1 });
  assert.deepEqual((await call('A', 'POST', `/${id}/segments`, { segments: [seg('v2-again', 2)] })).body, { written: 1, stale: 0 });
  const { items } = await readAll('A', id, 10);
  assert.equal(items[0].text, 'v2-again');
  // Within one request the highest revision wins regardless of order.
  await call('A', 'POST', `/${id}/segments`, { segments: [seg('v5', 5), seg('v4', 4)] });
  assert.equal((await readAll('A', id, 10)).items[0].text, 'v5');
});

test('legacy writes without a revision keep working against legacy documents', async () => {
  const id = await newMeeting();
  await call('A', 'POST', `/${id}/segments`, { segments: [{ messageId: '123_@456', text: 'old', ts: 1 }] });
  await call('A', 'POST', `/${id}/segments`, { segments: [{ messageId: '123_@456', text: 'newer', ts: 1 }] });
  assert.equal((await readAll('A', id, 10)).items[0].text, 'newer');
  // A versioned write over a legacy (unversioned) document is accepted.
  await call('A', 'POST', `/${id}/segments`, { segments: [{ messageId: '123_@456', text: 'versioned', rev: 0, ts: 1 }] });
  assert.equal((await readAll('A', id, 10)).items[0].text, 'versioned');
});

test('segment ids that Firestore would misinterpret are rejected', async () => {
  const id = await newMeeting();
  for (const bad of ['a/b', '.', '..', '__x__', '', 'x'.repeat(201)]) {
    assert.equal((await call('A', 'POST', `/${id}/segments`, { segments: [{ messageId: bad, text: 'x', ts: 1 }] })).status, 400, JSON.stringify(bad));
  }
});

test('cursor helpers round-trip and reject malformed input', () => {
  const c = encodeCursor(12, 'm2_ab');
  assert.deepEqual(decodeCursor(c), { ts: 12, id: 'm2_ab' });
  assert.equal(decodeCursor('%%%'), null);
  assert.equal(decodeCursor(encodeCursor(-1, 'x')), null);
  assert.equal(decodeCursor(encodeCursor(1, 'a/b')), null);
  assert.equal(parsePageLimit(undefined), 500);
  assert.equal(parsePageLimit('1000'), 1000);
  assert.equal(parsePageLimit('1.5'), null);
  assert.ok(isValidSegmentDocId('m2_0123'));
});

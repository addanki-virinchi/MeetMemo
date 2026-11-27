import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, httpError } from '../middleware/error.js';
import { SCHEMA_VERSION } from '../lib/schema.js';
import {
  isValidSegmentDocId, isStaleRevision, collapseBatch, encodeCursor, decodeCursor, parsePageLimit,
} from '../lib/segments.js';

// Router factory with injected Firestore pieces, so the routes can be tested against an
// in-memory fake (backend/test/). routes/meetings.js wires in the real Firebase Admin SDK.
export function createMeetingsRouter({ db, FieldValue, FieldPath }) {
  const router = Router();
  const meetings = db.collection('meetings');

  const createSchema = z.object({
    title: z.string().trim().max(300).default('Untitled meeting'),
    platform: z.enum(['googlemeet', 'msteams', 'zoom', 'upwork']),
    meetingCode: z.string().max(100).optional(),
    language: z.string().max(20).optional(),
    // 2 = segment ids are "m2_" hashes of the source id (sync/segment-id.js). Absent = legacy.
    segmentIdScheme: z.literal(2).optional(),
  });
  const patchSchema = z.object({
    title: z.string().trim().max(300).optional(),
    language: z.string().max(20).optional(),
  }).strict();
  const segmentsSchema = z.object({
    segments: z.array(z.object({
      messageId: z.string().refine(isValidSegmentDocId, 'invalid segment id'), // document id => idempotent writes
      sourceId: z.string().max(1000).optional(), // original caption id (scheme 2), for traceability
      rev: z.number().int().nonnegative().optional(), // caption revision; older revisions never overwrite newer
      speaker: z.string().max(200).optional(),
      text: z.string().max(10000),
      langId: z.string().max(20).optional(),
      ts: z.number().int().nonnegative(),
    })).min(1).max(400), // Firestore transaction/batch limit is 500 writes
  });

  // Ownership check shared by every route that touches a meeting.
  async function ownedMeeting(req) {
    const ref = meetings.doc(req.params.id);
    const snap = await ref.get();
    // 404 (not 403) so IDs of other users' meetings cannot be probed.
    if (!snap.exists || snap.data().ownerId !== req.user.uid) throw httpError(404, 'not_found', 'Meeting not found');
    return { ref, snap };
  }

  router.post('/', asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const ref = meetings.doc();
    await ref.set({
      ...body,
      ownerId: req.user.uid,
      visibility: 'private',
      status: 'active',
      schemaVersion: SCHEMA_VERSION,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.status(201).json({ id: ref.id });
  }));

  // Cursor pagination, newest first. Needs index ownerId ASC + createdAt DESC (firestore.indexes.json).
  router.get('/', asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    let q = meetings.where('ownerId', '==', req.user.uid).orderBy('createdAt', 'desc').limit(limit);
    if (req.query.after) {
      const cursor = await meetings.doc(String(req.query.after)).get();
      if (cursor.exists && cursor.data().ownerId === req.user.uid) q = q.startAfter(cursor);
    }
    const snap = await q.get();
    res.json({
      items: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
      next: snap.size === limit ? snap.docs[snap.size - 1].id : null,
    });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const { snap } = await ownedMeeting(req);
    res.json({ id: snap.id, ...snap.data() });
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const body = patchSchema.parse(req.body);
    const { ref } = await ownedMeeting(req);
    await ref.update({ ...body, updatedAt: FieldValue.serverTimestamp() });
    res.status(204).end();
  }));

  // Transcript lines live in a subcollection so long meetings never hit the 1 MiB document limit.
  // Writes run in a transaction so a stale request that arrives late (an overlapping retry or
  // a slow earlier batch) cannot replace a newer revision of the same line.
  router.post('/:id/segments', asyncHandler(async (req, res) => {
    const { segments } = segmentsSchema.parse(req.body);
    const { ref } = await ownedMeeting(req);
    const incoming = collapseBatch(segments);
    const result = await db.runTransaction(async (tx) => {
      const refs = incoming.map((s) => ref.collection('segments').doc(s.messageId));
      const snaps = await tx.getAll(...refs);
      let written = 0;
      let stale = 0;
      incoming.forEach((s, i) => {
        const stored = snaps[i].exists ? snaps[i].data() : null;
        if (stored && isStaleRevision(s.rev, stored.rev)) { stale += 1; return; }
        tx.set(refs[i], s, { merge: true });
        written += 1;
      });
      tx.update(ref, { updatedAt: FieldValue.serverTimestamp() });
      return { written, stale };
    });
    res.json(result);
  }));

  // Stable pages ordered by (ts, document id). `next` is null only on the last page.
  router.get('/:id/segments', asyncHandler(async (req, res) => {
    const limit = parsePageLimit(req.query.limit);
    if (limit === null) throw httpError(400, 'invalid_request', `limit must be an integer between 1 and 1000`);
    let cursor = null;
    if (req.query.after !== undefined) {
      cursor = decodeCursor(req.query.after);
      if (!cursor) throw httpError(400, 'invalid_request', 'Invalid page cursor');
    }
    const { ref } = await ownedMeeting(req);
    let q = ref.collection('segments').orderBy('ts').orderBy(FieldPath.documentId()).limit(limit + 1);
    if (cursor) q = q.startAfter(cursor.ts, cursor.id);
    const snap = await q.get();
    const docs = snap.docs.slice(0, limit);
    const last = docs[docs.length - 1];
    res.json({
      items: docs.map((d) => ({ id: d.id, ...d.data() })),
      next: snap.docs.length > limit ? encodeCursor(last.data().ts, last.id) : null,
    });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const { ref } = await ownedMeeting(req);
    await db.recursiveDelete(ref); // also removes segments
    res.status(204).end();
  }));

  return router;
}

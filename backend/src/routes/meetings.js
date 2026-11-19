import { Router } from 'express';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { SCHEMA_VERSION } from './users.js';

const router = Router();
const meetings = db.collection('meetings');

const createSchema = z.object({
  title: z.string().trim().max(300).default('Untitled meeting'),
  platform: z.enum(['googlemeet', 'msteams', 'zoom']),
  meetingCode: z.string().max(100).optional(),
  language: z.string().max(20).optional(),
});
const patchSchema = z.object({
  title: z.string().trim().max(300).optional(),
  language: z.string().max(20).optional(),
}).strict();
const segmentsSchema = z.object({
  segments: z.array(z.object({
    messageId: z.string().min(1).max(200), // stable id => idempotent writes
    speaker: z.string().max(200).optional(),
    text: z.string().max(10000),
    langId: z.string().max(20).optional(),
    ts: z.number().int().nonnegative(),
  })).min(1).max(400), // Firestore batch limit is 500 writes
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
router.post('/:id/segments', asyncHandler(async (req, res) => {
  const { segments } = segmentsSchema.parse(req.body);
  const { ref } = await ownedMeeting(req);
  const batch = db.batch();
  for (const s of segments) batch.set(ref.collection('segments').doc(s.messageId), s, { merge: true });
  batch.update(ref, { updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();
  res.status(204).end();
}));

router.get('/:id/segments', asyncHandler(async (req, res) => {
  const { ref } = await ownedMeeting(req);
  const limit = Math.min(Number(req.query.limit) || 500, 1000);
  const snap = await ref.collection('segments').orderBy('ts').limit(limit).get();
  res.json({ items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { ref } = await ownedMeeting(req);
  await db.recursiveDelete(ref); // also removes segments
  res.status(204).end();
}));

export default router;

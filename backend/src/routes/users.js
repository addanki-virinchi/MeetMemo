import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';
import { asyncHandler } from '../middleware/error.js';

import { SCHEMA_VERSION } from '../lib/schema.js';

export { SCHEMA_VERSION };
const router = Router();

// Create-or-update the caller's profile on first authenticated request.
router.post('/me', asyncHandler(async (req, res) => {
  const { uid, email, name, picture } = req.user;
  const ref = db.collection('users').doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const base = { email, displayName: name, photoURL: picture, lastLoginAt: FieldValue.serverTimestamp() };
    if (snap.exists) tx.update(ref, base);
    else tx.set(ref, { ...base, schemaVersion: SCHEMA_VERSION, createdAt: FieldValue.serverTimestamp() });
  });
  const out = (await ref.get()).data();
  res.json({ uid, ...out });
}));

export default router;

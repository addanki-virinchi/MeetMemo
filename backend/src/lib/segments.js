// Pure helpers for transcript segments: id validation, revision ordering and page cursors.
// Kept free of Firebase imports so they can be unit-tested without credentials.

export const MAX_SEGMENT_PAGE = 1000;
export const DEFAULT_SEGMENT_PAGE = 500;

// Firestore document ids may not contain "/", be "." or "..", or match __.*__.
// Current clients send "m2_" + 32 hex chars (see sync/segment-id.js); older clients sent
// lossy legacy ids, which stay accepted so existing meetings keep working.
export function isValidSegmentDocId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200
    && !id.includes('/') && id !== '.' && id !== '..' && !/^__.*__$/.test(id);
}

// Revision rule shared with the extension: a write is stale only when both sides carry a
// revision and the incoming one is strictly lower. Equal revisions are idempotent upserts
// (last write wins), and writes without a revision (legacy clients) behave as before.
export function isStaleRevision(incomingRev, storedRev) {
  return Number.isInteger(incomingRev) && Number.isInteger(storedRev) && incomingRev < storedRev;
}

// Within one request, keep only the highest revision per document id; on a tie the later
// entry wins, matching what sequential writes would have done.
export function collapseBatch(segments) {
  const byId = new Map();
  for (const s of segments) {
    const prev = byId.get(s.messageId);
    if (!prev || !isStaleRevision(s.rev, prev.rev)) byId.set(s.messageId, s);
  }
  return [...byId.values()];
}

// Opaque continuation cursor: base64url(JSON [ts, docId]). Segments are ordered by ts and
// then document id, so equal timestamps still have one deterministic order.
export function encodeCursor(ts, id) {
  return Buffer.from(JSON.stringify([ts, id]), 'utf8').toString('base64url');
}

export function decodeCursor(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 600) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 2) return null;
    const [ts, id] = v;
    if (!Number.isInteger(ts) || ts < 0 || !isValidSegmentDocId(id)) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

// Returns a number in [1, MAX_SEGMENT_PAGE], DEFAULT_SEGMENT_PAGE when absent, or null when invalid.
export function parsePageLimit(raw) {
  if (raw === undefined || raw === '') return DEFAULT_SEGMENT_PAGE;
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_SEGMENT_PAGE ? n : null;
}

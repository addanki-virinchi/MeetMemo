// Transcript segment document ids (classic script; loaded by the service worker).
//
// Scheme 2 (meetings created by this version): "m2_" + the first 32 hex characters
// (128 bits) of SHA-256 over the UTF-8 caption message id. Deterministic, so retries upsert
// the same document; fixed length, so long ids with a shared prefix stay distinct; and
// collision-resistant for any input (slashes, underscores, Unicode). The original id is also
// stored on the segment as sourceId.
//
// Scheme 1 (legacy): the previous lossy encoding ("/" -> "_", cut at 200 characters). It is
// used only for meetings the earlier version already created in the current tab session, so
// lines re-sent after the upgrade land on their existing documents instead of duplicating.
// New meetings never use it.
(() => {
  async function segmentDocIdV2(sourceId) {
    const bytes = new TextEncoder().encode(String(sourceId));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let hex = '';
    for (let i = 0; i < 16; i += 1) hex += digest[i].toString(16).padStart(2, '0');
    return `m2_${hex}`;
  }

  const segmentDocIdLegacy = (sourceId) => String(sourceId).replace(/\//g, '_').slice(0, 200);

  function segmentDocId(sourceId, scheme) {
    return scheme === 2 ? segmentDocIdV2(sourceId) : Promise.resolve(segmentDocIdLegacy(sourceId));
  }

  self.MeetMemoSegmentId = { segmentDocId, segmentDocIdV2, segmentDocIdLegacy };
})();

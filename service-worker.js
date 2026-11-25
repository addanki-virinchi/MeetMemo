// Extension service worker entry point.
// Loads the bundled MeetMemo background (unchanged) plus the local auth/sync layer.
// The bundle is loaded inside try/catch so a failure there cannot stop transcript sync.
try {
  importScripts('background.js');
} catch (err) {
  console.error('[MeetMemo] bundled background.js failed to load', err);
}
// Order matters: config, shared session helpers, the session authority (sole writer of the
// local session), segment ids, then the sync engine that wires everything up.
importScripts(
  'meetmemo.config.js',
  'extension-auth/session.js',
  'extension-auth/sessionAuthority.js',
  'sync/segment-id.js',
  'sync/worker.js',
);

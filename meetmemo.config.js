// Shared, public (non-secret) settings for the MeetMemo auth + sync layer.
// Loaded by extension pages via <script src> and by the service worker via importScripts,
// so both read the same values. Don't edit by hand: `node scripts/set-api-url.mjs <url>`
// updates this file and the matching manifest.json "host_permissions" entry together.
// Moving hosts (Render -> DigitalOcean -> ...) only means running that script again.
self.MEETMEMO_CONFIG = {
  apiBaseUrl: 'https://meetmemo-api.onrender.com',
};

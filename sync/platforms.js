// Meeting platforms the extension captures, and how each one identifies a meeting.
//
// Classic script, loaded before sync/content.js in meeting tabs, before sync/upwork.js on
// Upwork, and by tests. Defines self.MeetMemoPlatforms.
//
// Host patterns match the bundled panel and rtcinjector.js exactly (content.js `zi`/`ca`/`_n`),
// so this layer runs wherever the panel runs:
//   googlemeet  meet.google.com/abc-defg-hij           code = abc-defg-hij
//   zoom        *.zoom.us/wc/<number>/(join|start)     code = the Zoom meeting number
//               (browser web client only; the desktop app has no captions the extension can read)
//   msteams     teams.microsoft.com, teams.live.com,   code = id reported by msteams.inline.js
//               teams.cloud.microsoft (+ gov / MCAS)   ('meeting-id' event), else one per tab
(() => {
  const MEET_HOST = 'meet.google.com';
  const ZOOM_HOST = /^([a-zA-Z0-9](?:[-a-zA-Z0-9]{0,61}[a-zA-Z0-9])?\.)?zoom\.us$/;
  const TEAMS_HOST = /^(gov\.)?teams\.(microsoft|live)(\.com(\.cas\.ms|\.mcas\.ms|\.mcas-gov\.us)?|\.us)$|^teams\.cloud\.microsoft(\.mcas\.ms|\.cas\.ms)?$/;
  const MEET_CODE = /^\/(?:meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/;
  const ZOOM_WC = /^\/wc\/(\d{6,})(?:$|[/?#])/;
  const MAX_CODE = 100; // backend limit for meetingCode

  const NAMES = { googlemeet: 'Google Meet', zoom: 'Zoom', msteams: 'Microsoft Teams' };
  const UPWORK_KEY = 'meetmemo_upwork_calls'; // chrome.storage.local, written by sync/upwork.js

  function platformOf(loc) {
    const host = String(loc?.host || '').toLowerCase();
    if (host === MEET_HOST) return 'googlemeet';
    if (ZOOM_HOST.test(host)) return 'zoom';
    if (TEAMS_HOST.test(host)) return 'msteams';
    return null;
  }

  // The meeting this tab is in, or null when it is not in one (lobby, landing page, settings).
  // reportedId: Teams' adapter-reported meeting id. store: sessionStorage, for the per-tab
  // Teams fallback when captions arrive before (or without) a reported id.
  function meetingCode(platform, loc, reportedId = null, store = null) {
    const path = String(loc?.pathname || '');
    if (platform === 'googlemeet') return path.match(MEET_CODE)?.[1] ?? null;
    if (platform === 'zoom') return path.match(ZOOM_WC)?.[1] ?? null;
    if (platform === 'msteams') {
      if (reportedId) return String(reportedId).slice(0, MAX_CODE);
      if (!store) return null;
      const key = 'meetmemo_teams_call';
      let id = store.getItem(key);
      if (!id) {
        id = `call-${Math.random().toString(36).slice(2, 10)}`;
        store.setItem(key, id);
      }
      return id;
    }
    return null;
  }

  // A meeting link (as shared in Upwork Messages) -> "platform:code", or null.
  // Zoom: zoom.us/j/<n>, /s/<n>, /w/<n>, /wc/<n>/..., any *.zoom.us subdomain.
  // Google Meet: meet.google.com/abc-defg-hij. Teams links carry no usable id, so are skipped.
  function linkKey(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.host.toLowerCase();
    if (ZOOM_HOST.test(host)) {
      const n = u.pathname.match(/^\/(?:j|s|w|wc)\/(\d{6,})(?:$|[/?#])/)?.[1];
      return n ? `zoom:${n}` : null;
    }
    if (host === MEET_HOST) {
      const c = u.pathname.match(MEET_CODE)?.[1];
      return c ? `googlemeet:${c}` : null;
    }
    return null;
  }

  self.MeetMemoPlatforms = { NAMES, UPWORK_KEY, platformOf, meetingCode, linkKey };
})();

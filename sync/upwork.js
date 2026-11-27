// Upwork client calls (classic content script on *.upwork.com; requires sync/platforms.js).
//
// Upwork client calls started from Upwork Messages run on Zoom (Upwork's Zoom integration
// posts a join link in the message room), or on a Google Meet link someone shares there. The
// call itself is captured by the regular Zoom / Google Meet support. This script only notes
// which meetings were shared in Upwork, so the saved meeting is titled "Upwork client call"
// and is easy to find later.
//
// What is stored: "platform:code" keys (e.g. "zoom:81234567890") with the time they were
// seen, in chrome.storage.local, for at most MAX_AGE_MS and MAX_ENTRIES. No message text, names
// or other page content is read or stored.
//
// Upwork's own built-in video meetings are not captured: they expose no caption stream to the
// page, and MeetMemo never records audio.
(() => {
  const P = self.MeetMemoPlatforms;
  // Upwork only: if the optional all-sites permission was granted, webext-dynamic-content-scripts
  // also registers this script on every other site, where it must do nothing.
  if (!P || !/(^|\.)upwork\.com$/i.test(location.hostname)) return;
  const KEY = P.UPWORK_KEY;
  const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  const MAX_ENTRIES = 200;
  const SCAN_MS = 1500;
  const seen = new Set();

  async function remember(keys) {
    const fresh = keys.filter((k) => !seen.has(k));
    if (!fresh.length) return;
    fresh.forEach((k) => seen.add(k));
    try {
      const cur = (await chrome.storage.local.get(KEY))[KEY] || {};
      const now = Date.now();
      for (const k of fresh) cur[k] = now;
      const kept = Object.entries(cur)
        .filter(([, at]) => now - at < MAX_AGE_MS)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_ENTRIES);
      await chrome.storage.local.set({ [KEY]: Object.fromEntries(kept) });
    } catch { /* extension reloaded; the next scan retries */ fresh.forEach((k) => seen.delete(k)); }
  }

  const keysIn = (root) => [...root.querySelectorAll('a[href]')]
    .map((a) => P.linkKey(a.href))
    .filter(Boolean);

  function scan() {
    try { void remember([...new Set(keysIn(document))]); } catch { /* page not ready */ }
  }

  // Links opened from Upwork (including ones rendered after the last scan).
  addEventListener('click', (e) => {
    const a = e.target?.closest?.('a[href]');
    const k = a && P.linkKey(a.href);
    if (k) void remember([k]);
  }, true);

  let timer = null;
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; scan(); }, SCAN_MS); };
  const start = () => {
    scan();
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  self.MeetMemoUpwork = { scan, remember };
})();

// MeetMemo transcript sync — Google Meet content-script side.
//
// The page adapter (googlemeet.inline.js) emits "MeetMemo-message" DOM events that the
// bundled panel (content.js) consumes. This script listens to the same events and hands
// changed caption lines to the service worker (sync/worker.js), which stores them in a
// durable queue before acknowledging ("received") and uploads them to the backend.
//
// - Revisions: the highest revision accepted per caption id is remembered independently of
//   delivery, so a late lower revision is ignored even after the newer one was delivered.
//   Equal revisions with identical text are duplicates; equal revisions with different text
//   are accepted (the backend treats equal revisions as idempotent upserts, last write wins).
// - Delivery: pending lines are handed over about once a second, so a tab close loses at
//   most the last second; pagehide sends a best-effort extra copy (idempotent by revision).
// - Pause: while the panel's transcript is paused (Pause button or auto-pause), captions are
//   ignored here too, exactly like the panel ignores them.
// Classic content script; requires extension-auth/session.js and extension-auth/links.js.
(() => {
  const PORT_NAME = 'meetmemo-sync';
  const CODE_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/;
  const FLUSH_MS = 1000;
  const MAX_BATCH = 400;
  const MAX_PENDING = 5000; // only reached if the extension worker is unreachable
  const MAX_TRACKED = 20000; // revision history entries kept per tab
  const MAX_SPEAKERS = 1000;
  const REPLY_TIMEOUT_MS = 10000;
  const OPEN_FLUSH_TIMEOUT_MS = 5000;

  const speakers = new Map(); // deviceId -> display name
  const accepted = new Map(); // caption id -> { rev, text, ts } highest accepted revision
  const pending = new Map(); // caption id -> line awaiting durable receipt
  let port = null;
  let inFlight = null; // { id, entries, timer }
  let seq = 0;
  let stopped = false;
  let dropped = 0;
  const drainWaiters = new Set();

  const meetingCode = () => location.pathname.match(CODE_RE)?.[1] ?? null;
  const cap = (map, max) => { while (map.size > max) map.delete(map.keys().next().value); };

  // One backend meeting per tab session; a page reload continues the same meeting.
  function sessionId(code) {
    const key = `meetmemo_sync_session_${code}`;
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(key, id);
    }
    return id;
  }

  function meetingInfo(code) {
    let startedAt = Date.now();
    for (const a of accepted.values()) if (a.ts < startedAt) startedAt = a.ts;
    return {
      sessionId: sessionId(code),
      platform: 'googlemeet',
      meetingCode: code,
      title: `Google Meet ${code} — ${new Date(startedAt).toLocaleString()}`,
    };
  }

  // The panel's own pause state, read through the bridge exposed by content.js (Fl patch).
  function isPaused() {
    try {
      return !!self.MEETMEMO_PANEL?.currentTranscript?.()?.isPaused;
    } catch {
      return false;
    }
  }

  function rememberSpeaker(d) {
    if (d?.deviceId && d.deviceName) {
      speakers.set(d.deviceId, d.deviceName);
      cap(speakers, MAX_SPEAKERS);
    }
  }

  function queue(m) {
    if (!m || m.type === 'chat' || m.messageId == null) return; // in-meeting chat is not transcript
    const text = String(m.text ?? '').trim().slice(0, 10000);
    if (!text) return;
    const key = String(m.messageId);
    const rev = Math.max(0, Math.floor(Number(m.messageVersion) || 0));
    const prev = accepted.get(key);
    if (prev && (rev < prev.rev || (rev === prev.rev && text === prev.text))) return; // stale or duplicate
    const ts = prev?.ts ?? Date.now(); // first-seen time keeps ordering stable across edits
    accepted.delete(key); // re-insert so the cap evicts the least recently changed
    accepted.set(key, { rev, text, ts });
    cap(accepted, MAX_TRACKED);
    const speaker = m.deviceName || speakers.get(m.deviceId);
    const langId = m.langId ?? m.zoomLanguage;
    pending.delete(key);
    pending.set(key, {
      sourceId: key,
      rev,
      text,
      ts,
      ...(speaker ? { speaker: String(speaker).slice(0, 200) } : {}),
      ...(langId != null && langId !== '' ? { langId: String(langId).slice(0, 20) } : {}),
    });
    while (pending.size > MAX_PENDING) {
      pending.delete(pending.keys().next().value);
      dropped += 1;
      console.warn('[MeetMemo sync] dropping unsent line; the extension background is not responding');
    }
  }

  function stop(reason) {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    drainWaiters.forEach((w) => w(false));
    console.info(`[MeetMemo sync] stopped: ${reason}`);
  }

  function getPort() {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch (err) {
      stop(`extension was reloaded (${err.message}); refresh the Meet tab`);
      return null;
    }
    port.onMessage.addListener(onReply);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      if (inFlight) settle(null); // receipt lost; lines stay pending and are resent
    });
    return port;
  }

  function settle(reply) {
    const req = inFlight;
    inFlight = null;
    if (!req) return;
    clearTimeout(req.timer);
    if (reply?.ok) {
      // Drop only lines that did not change while the batch was in flight.
      for (const [key, line] of req.entries) if (pending.get(key) === line) pending.delete(key);
    } else if (reply) {
      console.warn('[MeetMemo sync] could not queue lines:', reply.message || reply.error);
    }
    if (!pending.size) drainWaiters.forEach((w) => w(true));
    else if (reply?.ok) flush(); // keep going while there is more
  }

  function onReply(msg) {
    if (msg?.type === 'received' && inFlight && msg.id === inFlight.id) settle(msg);
  }

  function post(p, entries, id) {
    const code = meetingCode();
    p.postMessage({ type: 'lines', id, meeting: meetingInfo(code), lines: entries.map(([, line]) => line), dropped });
  }

  function flush() {
    if (stopped || inFlight || !pending.size || !meetingCode()) return;
    const p = getPort();
    if (!p) return;
    const entries = [...pending.entries()].slice(0, MAX_BATCH);
    const id = ++seq;
    inFlight = { id, entries, timer: setTimeout(() => settle(null), REPLY_TIMEOUT_MS) };
    try {
      post(p, entries, id);
    } catch {
      port = null;
      settle(null);
    }
  }

  // Resolves true once every pending line has a durable receipt, false on timeout/stop.
  function flushAll(timeoutMs) {
    if (!pending.size) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (done) return; done = true; drainWaiters.delete(finish); clearTimeout(t); resolve(ok); };
      const t = setTimeout(() => finish(false), timeoutMs);
      drainWaiters.add(finish);
      flush();
    });
  }

  document.documentElement.addEventListener('MeetMemo-message', (event) => {
    const d = event.detail;
    if (!d || stopped) return;
    switch (d.type) {
      case 'speech':
        if (isPaused()) return; // the panel drops captions while paused; so do we
        for (const m of d.messages || []) queue(m);
        break;
      case 'deviceinfo':
      case 'self-device':
        rememberSpeaker(d);
        break;
      case 'premeeting-devices':
        for (const dev of d.devices || []) rememberSpeaker(dev);
        break;
      default:
        break;
    }
  });

  const interval = setInterval(flush, FLUSH_MS);
  // Best effort only: durability comes from the frequent hand-over above. Sends even while a
  // batch is in flight; duplicates are harmless because writes are idempotent per revision.
  addEventListener('pagehide', () => {
    if (stopped || !pending.size || !meetingCode()) return;
    const p = getPort();
    if (!p) return;
    try { post(p, [...pending.entries()].slice(0, MAX_BATCH), ++seq); } catch { /* unloading */ }
  });

  // Used by extension-auth/links.js for the panel's Share button: hand every captured line
  // to the durable queue first (bounded wait), then open this meeting's private transcript,
  // which follows the remaining upload and refreshes as lines are saved.
  self.MEETMEMO_SYNC = {
    async openTranscript() {
      const code = meetingCode();
      if (code) await flushAll(OPEN_FLUSH_TIMEOUT_MS);
      // Fire and forget: no reply is expected (and the bundled background.js keeps every
      // runtime message channel open, so awaiting a reply would never settle).
      try {
        chrome.runtime.sendMessage(code
          ? { type: 'meetmemo-open', target: 'transcript', meeting: meetingInfo(code) }
          : { type: 'meetmemo-open', target: 'signin' }).catch(() => {});
      } catch (err) {
        console.warn('[MeetMemo] extension was reloaded; refresh the Meet tab', err);
      }
    },
  };
})();

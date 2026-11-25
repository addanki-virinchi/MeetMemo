// MeetMemo transcript sync — service-worker side.
//
// Delivery model (see README "Local sync"):
//   1. Meeting tabs (sync/content.js) send changed caption lines over the "meetmemo-sync"
//      port. Each batch is merged into a durable queue in chrome.storage.local and only then
//      acknowledged ("received"). A receipt means the line survives tab close and worker
//      restart; it does NOT mean the backend has it yet.
//   2. A single upload loop moves queued lines to the backend (/v1/meetings/:id/segments),
//      removing a line only after the backend accepted that exact revision. Failures retry
//      with backoff, on a chrome.alarms heartbeat and at worker start-up.
//
// Ownership: a queue belongs to the account signed in when its lines were received
// (key meetmemo_q:<tabSession>:<uid>). It is uploaded only with that account's token, never
// with another account's. Lines captured while signed out (owner "~anon") are claimed by the
// next account that signs in, which preserves "sign in to save this meeting". Queues held for
// another account wait up to HELD_RETENTION_MS for that account to sign in again.
//
// Meeting mappings are one storage key per account + tab session (meetmemo_map:<uid>:<tab>),
// so concurrent meetings never overwrite each other's mapping.
//
// Classic script (importScripts); requires meetmemo.config.js, extension-auth/session.js,
// extension-auth/sessionAuthority.js and sync/segment-id.js to be loaded first.
(() => {
  const ANON = '~anon';
  const Q_PREFIX = 'meetmemo_q:';
  const MAP_PREFIX = 'meetmemo_map:';
  const LEGACY_MAP_KEY = 'meetmemo_sync_meetings'; // storage.session, previous version
  const MAX_QUEUE_LINES = 5000; // per tab session; overflow drops oldest and is reported
  const MAX_TEXT = 10000; // backend limit per line
  const MAX_BATCH = 400; // backend accepts at most 400 segments per request
  const HELD_RETENTION_MS = 7 * 24 * 3600_000;
  const MAPPING_RETENTION_MS = 30 * 24 * 3600_000;
  const REQUEST_TIMEOUT_MS = 60_000; // a sleeping free-tier host can take ~50 s to wake up
  const MAX_STATUS_MEETINGS = 5;
  const RETRY_MIN_MS = 2_000;
  const RETRY_MAX_MS = 60_000;

  const fail = (code, message, status) => Object.assign(new Error(message), { code, status });
  const qKey = (tab, owner) => `${Q_PREFIX}${tab}:${owner}`;
  const mapKey = (uid, tab) => `${MAP_PREFIX}${uid}:${tab}`;
  const parseQKey = (k) => { const rest = k.slice(Q_PREFIX.length); const i = rest.lastIndexOf(':'); return { tab: rest.slice(0, i), owner: rest.slice(i + 1) }; };

  function createSyncEngine({
    storage, sessionStorage, authority, baseUrl, segmentDocId, statusKey,
    fetchImpl = (...a) => fetch(...a), now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms), log = console,
  }) {
    const S = self.MeetMemoSession;
    let chain = Promise.resolve();
    // Serializes every read-modify-write of queue/status keys in this (only) writer context.
    const mutate = (fn) => { const run = chain.then(fn, fn); chain = run.then(() => {}, () => {}); return run; };
    const get = async (k) => (await storage.get(k))[k];
    const creating = new Map(); // `${uid}:${tab}` -> Promise<mapping>
    let draining = null;
    let rerun = false;
    let retryDelay = RETRY_MIN_MS;
    let retryPending = false;

    async function api(idToken, path, { method = 'GET', body } = {}) {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${idToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw fail(err.error || 'http_error', err.message || `HTTP ${res.status}`, res.status);
      }
      return res.status === 204 ? null : res.json();
    }

    // Token for exactly this account, or an error if the session is gone or switched.
    async function authFor(uid) {
      const auth = await authority.getAuth();
      if (!auth) throw fail('signed_out', 'Signed out');
      if (auth.user.uid !== uid) throw fail('account_changed', 'Signed-in account changed');
      return auth;
    }

    // ---- status (scoped to uid + session id) ----

    function setStatus(user, tab, patch) {
      return mutate(async () => {
        const current = await authority.getUser();
        if (!current || current.uid !== user.uid || current.sid !== user.sid) return; // stale identity
        let st = await get(statusKey);
        if (!S.statusFor(st, current)) st = { uid: current.uid, sid: current.sid, meetings: {} };
        st.meetings[tab] = { ...st.meetings[tab], ...patch, at: now() };
        const keep = Object.entries(st.meetings).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_STATUS_MEETINGS);
        st.meetings = Object.fromEntries(keep);
        await storage.set({ [statusKey]: st });
      });
    }

    // ---- durable receipt ----

    function receive({ meeting, lines }) {
      return mutate(async () => {
        const user = await authority.getUser();
        const owner = user?.uid ?? ANON;
        const key = qKey(meeting.sessionId, owner);
        const q = (await get(key)) || { tab: meeting.sessionId, owner, meeting: null, lines: {}, dropped: 0, createdAt: now() };
        q.meeting = q.meeting || { platform: meeting.platform, meetingCode: meeting.meetingCode, title: meeting.title };
        let accepted = 0;
        for (const l of lines) {
          const cur = q.lines[l.sourceId];
          if (cur && cur.rev > l.rev) continue; // older revision than one still queued
          q.lines[l.sourceId] = { rev: l.rev, text: l.text, ts: l.ts, ...(l.speaker ? { speaker: l.speaker } : {}), ...(l.langId ? { langId: l.langId } : {}) };
          accepted += 1;
        }
        const ids = Object.keys(q.lines);
        if (ids.length > MAX_QUEUE_LINES) {
          const drop = ids.sort((a, b) => q.lines[a].ts - q.lines[b].ts).slice(0, ids.length - MAX_QUEUE_LINES);
          for (const id of drop) delete q.lines[id];
          q.dropped += drop.length;
          log.warn(`[MeetMemo sync] queue full: dropped ${drop.length} unsaved line(s)`);
        }
        q.updatedAt = now();
        await storage.set({ [key]: q });
        return { owner, user, queued: Object.keys(q.lines).length, accepted, dropped: q.dropped };
      });
    }

    // ---- meeting mapping ----

    async function legacyMigration() {
      if (!sessionStorage) return;
      const old = (await sessionStorage.get(LEGACY_MAP_KEY))[LEGACY_MAP_KEY];
      if (!old) return;
      for (const [tab, m] of Object.entries(old)) {
        if (!m?.uid || !m.meetingId) continue;
        const k = mapKey(m.uid, tab);
        if (!(await get(k))) await storage.set({ [k]: { meetingId: m.meetingId, scheme: 1, at: now() } });
      }
      await sessionStorage.remove(LEGACY_MAP_KEY);
    }

    function ensureMeeting(uid, tab, meeting) {
      const ck = `${uid}:${tab}`;
      if (creating.has(ck)) return creating.get(ck);
      const p = (async () => {
        const existing = await get(mapKey(uid, tab));
        if (existing) return existing;
        const { idToken } = await authFor(uid);
        const { id } = await api(idToken, '/v1/meetings', {
          method: 'POST',
          body: { title: meeting.title, platform: meeting.platform, meetingCode: meeting.meetingCode, segmentIdScheme: 2 },
        });
        const mapping = { meetingId: id, scheme: 2, at: now() };
        // Per-account key: a creation that finishes after an account switch stays with its
        // own account and can never be attached to the new one.
        await storage.set({ [mapKey(uid, tab)]: mapping });
        return mapping;
      })().finally(() => creating.delete(ck));
      creating.set(ck, p);
      return p;
    }

    function forgetMeeting(uid, tab, meetingId) {
      return mutate(async () => {
        const k = mapKey(uid, tab);
        if ((await get(k))?.meetingId === meetingId) await storage.remove(k);
      });
    }

    // ---- upload ----

    // Moves lines captured while signed out into the signed-in account's queue.
    function claimAnonymous(user) {
      return mutate(async () => {
        const all = await storage.get(null);
        for (const [k, q] of Object.entries(all)) {
          if (!k.startsWith(Q_PREFIX) || parseQKey(k).owner !== ANON) continue;
          const target = qKey(q.tab, user.uid);
          const t = all[target] || { ...q, owner: user.uid, lines: {}, dropped: 0 };
          for (const [id, l] of Object.entries(q.lines)) if (!t.lines[id] || t.lines[id].rev <= l.rev) t.lines[id] = l;
          t.dropped += q.dropped || 0;
          t.updatedAt = now();
          await storage.set({ [target]: t });
          await storage.remove(k);
          all[target] = t;
        }
      });
    }

    async function uploadQueue(user, key) {
      const { tab } = parseQKey(key);
      let recreated = false;
      let reauthed = false;
      let limit = MAX_BATCH; // shrinks when the backend rejects a batch, to isolate one bad line
      for (;;) {
        const q = await get(key);
        const pending = q ? Object.entries(q.lines) : [];
        if (!pending.length) {
          if (q) await mutate(async () => { const cur = await get(key); if (cur && !Object.keys(cur.lines).length) await storage.remove(key); });
          return;
        }
        const mapping = await ensureMeeting(user.uid, tab, q.meeting);
        const batch = pending.sort((a, b) => a[1].ts - b[1].ts).slice(0, limit);
        await setStatus(user, tab, { meetingId: mapping.meetingId, meetingCode: q.meeting.meetingCode, state: 'saving', queued: pending.length, dropped: q.dropped, message: null });
        const segments = await Promise.all(batch.map(async ([sourceId, l]) => ({
          messageId: await segmentDocId(sourceId, mapping.scheme),
          ...(mapping.scheme === 2 ? { sourceId: sourceId.slice(0, 1000) } : {}),
          rev: l.rev,
          ...(l.speaker ? { speaker: l.speaker } : {}),
          text: String(l.text).slice(0, MAX_TEXT),
          ...(l.langId ? { langId: l.langId } : {}),
          ts: l.ts,
        })));
        const { idToken } = await authFor(user.uid);
        try {
          await api(idToken, `/v1/meetings/${encodeURIComponent(mapping.meetingId)}/segments`, { method: 'POST', body: { segments } });
        } catch (err) {
          // 400/413 means the backend refuses this exact content; retrying it unchanged would
          // block every later line forever. Halve the batch until one line is isolated, then drop it.
          if (err.status === 400 || err.status === 413) {
            if (batch.length > 1) { limit = Math.max(1, Math.floor(batch.length / 2)); continue; }
            const [badId, bad] = batch[0];
            log.warn(`[MeetMemo sync] backend rejected one line permanently, dropping it: ${err.message}`);
            await mutate(async () => {
              const cur = await get(key);
              if (!cur) return;
              const now_ = cur.lines[badId];
              if (now_ && now_.rev === bad.rev && now_.text === bad.text) { delete cur.lines[badId]; cur.dropped = (cur.dropped || 0) + 1; }
              if (Object.keys(cur.lines).length) await storage.set({ [key]: cur }); else await storage.remove(key);
            });
            limit = MAX_BATCH;
            continue;
          }
          // The backend rejected the token (clock skew, server-side revocation check, key rotation):
          // force one refresh and retry before treating it as a failure.
          if (err.status === 401 && !reauthed) {
            reauthed = true;
            await authority.getAuth({ forceRefresh: true });
            continue;
          }
          if (err.status === 404 && !recreated) { // meeting deleted: start a fresh one for this tab session
            recreated = true;
            await forgetMeeting(user.uid, tab, mapping.meetingId);
            continue;
          }
          throw err;
        }
        // Remove exactly what was saved; a line revised meanwhile stays queued.
        const remaining = await mutate(async () => {
          const cur = await get(key);
          if (!cur) return 0;
          for (const [sourceId, l] of batch) {
            const now_ = cur.lines[sourceId];
            if (now_ && now_.rev === l.rev && now_.text === l.text) delete cur.lines[sourceId];
          }
          const left = Object.keys(cur.lines).length;
          if (left) await storage.set({ [key]: cur }); else await storage.remove(key);
          return left;
        });
        const prev = S.statusFor(await get(statusKey), user)?.meetings?.[tab];
        await setStatus(user, tab, {
          meetingId: mapping.meetingId, state: remaining ? 'saving' : 'saved', queued: remaining,
          savedAt: now(), saved: (prev?.saved || 0) + batch.length, message: null,
        });
      }
    }

    async function drainOnce() {
      const user = await authority.getUser();
      const all = await storage.get(null);
      // Expire queues held for other accounts and stale mappings.
      for (const [k, v] of Object.entries(all)) {
        if (k.startsWith(Q_PREFIX) && parseQKey(k).owner !== user?.uid && now() - (v.updatedAt || 0) > HELD_RETENTION_MS) {
          log.warn(`[MeetMemo sync] discarding ${Object.keys(v.lines || {}).length} line(s) held too long for another account`);
          await mutate(() => storage.remove(k));
        }
        if (k.startsWith(MAP_PREFIX) && now() - (v.at || 0) > MAPPING_RETENTION_MS) await mutate(() => storage.remove(k));
      }
      if (!user) return;
      await claimAnonymous(user);
      const keys = Object.keys(await storage.get(null)).filter((k) => k.startsWith(Q_PREFIX) && parseQKey(k).owner === user.uid);
      let firstError = null;
      for (const key of keys) {
        try {
          await uploadQueue(user, key);
        } catch (err) {
          if (err.code === 'account_changed' || err.code === 'signed_out') return; // new identity: next drain handles it
          firstError = firstError || err;
          await setStatus(user, parseQKey(key).tab, { state: 'error', message: err.message || 'Save failed' });
        }
      }
      if (firstError) throw firstError;
    }

    function scheduleRetry() {
      if (retryPending) return;
      retryPending = true;
      const delay = retryDelay;
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      setTimer(() => { retryPending = false; drain(); }, delay);
    }

    // Single-flight: at most one upload loop runs; calls during a run schedule one more pass.
    function drain() {
      if (draining) { rerun = true; return draining; }
      draining = (async () => {
        do {
          rerun = false;
          try {
            await drainOnce();
            retryDelay = RETRY_MIN_MS;
          } catch (err) {
            log.warn('[MeetMemo sync] save failed, will retry:', err.message);
            scheduleRetry();
            return;
          }
        } while (rerun);
      })().finally(() => { draining = null; });
      return draining;
    }

    return { receive, drain, ensureMeeting, forgetMeeting, legacyMigration, setStatus, claimAnonymous, mutate };
  }

  self.MeetMemoSyncEngine = { createSyncEngine, qKey, mapKey, ANON, MAX_QUEUE_LINES };

  // ---- wiring (skipped by tests that load this file with MEETMEMO_SYNC_NO_AUTOSTART) ----
  if (self.MEETMEMO_SYNC_NO_AUTOSTART || !self.chrome?.runtime?.onConnect) return;

  const { apiBaseUrl } = self.MEETMEMO_CONFIG;
  const { STATUS_KEY } = self.MeetMemoSession;
  const { createSessionAuthority, installMessageHandler } = self.MeetMemoSessionAuthority;
  const authority = createSessionAuthority({ storage: chrome.storage.local, baseUrl: apiBaseUrl });
  installMessageHandler(authority);
  const engine = createSyncEngine({
    storage: chrome.storage.local,
    sessionStorage: chrome.storage.session,
    authority,
    baseUrl: apiBaseUrl,
    segmentDocId: self.MeetMemoSegmentId.segmentDocId,
    statusKey: STATUS_KEY,
  });
  self.MeetMemoSync = { authority, engine };

  const PORT_NAME = 'meetmemo-sync';
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME || port.sender?.id !== chrome.runtime.id) return;
    port.onMessage.addListener(async (msg) => {
      if (msg?.type !== 'lines' || !msg.meeting?.sessionId || !Array.isArray(msg.lines)) return;
      let reply;
      try {
        const r = await engine.receive(msg);
        reply = { ok: true, queued: r.queued, signedIn: r.owner !== ANON };
        if (r.user) await engine.setStatus(r.user, msg.meeting.sessionId, { meetingCode: msg.meeting.meetingCode, state: 'saving', queued: r.queued, dropped: r.dropped });
      } catch (err) {
        reply = { ok: false, error: err.code || 'error', message: err.message };
      }
      try { port.postMessage({ type: 'received', id: msg.id, ...reply }); } catch { /* tab went away */ }
      if (reply.ok) engine.drain();
    });
  });

  // ---- Sign in / Share / app links from the in-meeting panel (MEETMEMO_LINKS in sync/content.js) ----
  const pageUrl = (p) => chrome.runtime.getURL(p);
  const openSignIn = () => chrome.windows.create({ url: pageUrl('auth.html'), type: 'popup', width: 380, height: 640 });
  const OWN_PAGES = ['history', 'settings', 'help', 'privacy'];
  const openTab = (url, tab) => chrome.tabs.create({ url, ...(tab ? { index: tab.index + 1, windowId: tab.windowId } : {}) });

  async function openTranscript(meeting, tab) {
    const user = await authority.getUser();
    if (!user) return openSignIn(); // saving and viewing need an account
    await engine.claimAnonymous(user);
    try {
      const mapping = await engine.ensureMeeting(user.uid, meeting.sessionId, meeting);
      engine.drain();
      return openTab(pageUrl(`transcript.html?id=${encodeURIComponent(mapping.meetingId)}&live=1`), tab);
    } catch (err) {
      // Signed in but the meeting could not be created (backend down, etc.): show the
      // failure in the viewer instead of pretending the user needs to sign in.
      return openTab(pageUrl(`transcript.html?error=${encodeURIComponent(err.message || 'Could not reach the backend')}`), tab);
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== 'meetmemo-open' || sender.id !== chrome.runtime.id) return;
    let run;
    if (msg.target === 'transcript' && msg.meeting?.sessionId) run = openTranscript(msg.meeting, sender.tab);
    else if (msg.target === 'unavailable') run = openTab(pageUrl(`unavailable.html?feature=${encodeURIComponent(msg.feature || 'hosted')}`), sender.tab);
    else if (msg.target === 'page') {
      if (!OWN_PAGES.includes(msg.page)) return; // only the extension's own pages
      run = openTab(pageUrl(`${msg.page}.html`), sender.tab);
    }
    else run = openSignIn();
    run.catch((err) => console.warn('[MeetMemo] could not open page', err));
  });

  // Recovery: queued lines survive worker restarts; retry on start-up, on a heartbeat alarm
  // and whenever someone signs in.
  authority.onChange((user) => { if (user) engine.drain(); });
  chrome.alarms?.create('meetmemo-sync-retry', { periodInMinutes: 1 });
  chrome.alarms?.onAlarm.addListener((a) => { if (a.name === 'meetmemo-sync-retry') engine.drain(); });
  engine.legacyMigration().catch((e) => console.warn('[MeetMemo sync] legacy mapping migration failed', e)).finally(() => engine.drain());
})();

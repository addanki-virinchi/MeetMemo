// Claude tab assistant actions — service-worker side (classic; loaded after sync/live-worker.js).
//
// The Meet tab (sync/assist-dock.js) sends one request per button click over the
// "meetmemo-assist" port: { type: 'assist', reqId, action, meeting, lines, previous, userName }.
// This worker resolves the tab's canonical backend meeting (the same mapping transcript sync
// uses; the meeting is created if no line was uploaded yet), turns caption ids into stable
// segment ids, calls POST /v1/meetings/:id/ai/assist with the account's token and replies with
// { type: 'result', reqId, ok, data | error }. Nothing is stored here.
(() => {
  const PORT_NAME = 'meetmemo-assist';
  const PREFS_KEY = 'meetmemo_prefs';
  const TIMEOUT_MS = 240_000; // a sleeping host can take ~50 s to wake up; Opus at high effort can think for minutes
  const MAX_LINES = 600;
  const fail = (code, message) => Object.assign(new Error(message || code), { code });

  function createAssistEngine({ storage, authority, sync, baseUrl, segmentDocId, fetchImpl = (...a) => fetch(...a) }) {
    async function call(uid, path, body, retried = false) {
      const auth = await authority.getAuth(retried ? { forceRefresh: true } : undefined);
      if (!auth) throw fail('signed_out', 'Sign in to MeetMemo to use Claude.');
      if (auth.user.uid !== uid) throw fail('account_changed', 'The signed-in account changed. Try again.');
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${auth.idToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401 && !retried) return call(uid, path, body, true);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = res.status === 404 && data.error === 'route_not_found' ? 'route_not_found' : data.error || `http_${res.status}`;
        throw fail(code, data.message);
      }
      return data;
    }

    async function run(msg) {
      const user = await authority.getUser();
      if (!user) throw fail('signed_out', 'Sign in to MeetMemo to use Claude.');
      if (!msg.meeting?.sessionId) throw fail('no_meeting', 'Join the meeting first.');
      let mapping;
      try {
        mapping = await sync.ensureMeeting(user.uid, String(msg.meeting.sessionId), msg.meeting);
      } catch (err) {
        throw fail('network', err?.message);
      }
      const lines = [];
      for (const l of (Array.isArray(msg.lines) ? msg.lines : []).slice(-MAX_LINES)) {
        const text = String(l?.text || '').trim().slice(0, 4000);
        if (!text || l.sourceId == null) continue;
        lines.push({
          id: await segmentDocId(String(l.sourceId), mapping.scheme),
          ...(l.speaker ? { speaker: String(l.speaker).slice(0, 200) } : {}),
          ts: Math.max(0, Math.floor(Number(l.ts) || 0)),
          text,
        });
      }
      const prefs = (await storage.get(PREFS_KEY))[PREFS_KEY] || {};
      let timeZone;
      try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { timeZone = undefined; }
      const previous = (Array.isArray(msg.previous) ? msg.previous : [])
        .filter((p) => ['answer', 'next', 'close'].includes(p?.action) && String(p.text || '').trim())
        .slice(-30)
        .map((p) => ({ action: p.action, text: String(p.text).slice(0, 2000) }));
      return call(user.uid, `/v1/meetings/${encodeURIComponent(mapping.meetingId)}/ai/assist`, {
        action: msg.action,
        lines,
        previous,
        ...(msg.userName ? { userName: String(msg.userName).slice(0, 200) } : {}),
        ...(prefs.aiLanguage ? { answerLanguage: prefs.aiLanguage } : {}),
        ...(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].includes(prefs.aiModel) ? { model: prefs.aiModel } : {}),
        ...(['low', 'medium', 'high'].includes(prefs.aiEffort) ? { effort: prefs.aiEffort } : {}),
        ...(timeZone ? { timeZone } : {}),
      });
    }

    // How many uploaded context documents the assistant will use (shown in the Claude tab).
    async function docs() {
      const user = await authority.getUser();
      if (!user) throw fail('signed_out');
      const r = await call(user.uid, '/v1/context-docs');
      const items = r.items || [];
      return { active: items.filter((d) => d.active !== false).length, total: items.length };
    }

    return { run, docs };
  }

  self.MeetMemoAssist = { createAssistEngine };

  // ---- wiring (skipped by tests that load this file with MEETMEMO_SYNC_NO_AUTOSTART) ----
  if (self.MEETMEMO_SYNC_NO_AUTOSTART || !self.chrome?.runtime?.onConnect || !self.MeetMemoSync) return;
  const engine = createAssistEngine({
    storage: chrome.storage.local,
    authority: self.MeetMemoSync.authority,
    sync: self.MeetMemoSync.engine,
    baseUrl: self.MEETMEMO_CONFIG.apiBaseUrl,
    segmentDocId: self.MeetMemoSegmentId.segmentDocId,
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME || port.sender?.id !== chrome.runtime.id) return;
    let open = true;
    port.onDisconnect.addListener(() => { open = false; });
    port.onMessage.addListener(async (msg) => {
      const isAssist = msg?.type === 'assist' && ['answer', 'next', 'close'].includes(msg.action);
      if (!isAssist && msg?.type !== 'docs') return;
      let reply;
      try {
        reply = { type: 'result', reqId: msg.reqId, ok: true, data: isAssist ? await engine.run(msg) : await engine.docs() };
      } catch (err) {
        const code = err?.name === 'TimeoutError' ? 'timeout' : err instanceof TypeError ? 'network' : err?.code || 'failed';
        reply = { type: 'result', reqId: msg.reqId, ok: false, error: { code, message: err?.message || '' } };
      }
      if (open) { try { port.postMessage(reply); } catch { /* the tab went away */ } }
    });
  });
})();

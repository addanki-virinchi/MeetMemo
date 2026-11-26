// MeetMemo live auto-answer — service-worker side (classic script; loaded after sync/worker.js).
//
// Meet tabs (sync/content.js + sync/live-detect.js) send settled question candidates over the
// "meetmemo-sync" port. For each one this engine:
//   1. takes the signed-in account and waits for the canonical backend meeting of this tab
//      session (the same mapping sync/worker.js creates and uploads to);
//   2. drops it unless Auto-answer is on for that account + meeting, and the question was asked
//      after it was turned on;
//   3. converts caption ids to stable segment document ids, dedupes against cards it already has,
//      and sends one bounded request to POST /v1/meetings/:id/ai/live/answer (the backend checks
//      ownership again and is idempotent per question id);
//   4. streams the decision and answer into chrome.storage.session, which the live view
//      (ai/livePanel.js) renders. Session storage survives worker restarts, so a reopened view
//      restores cards without replaying anything; completed cards also live on the backend.
//
// Storage:
//   local   meetmemo_autoanswer:<uid>:<meetingId>  { on, at }  written by the live view / Claude switch
//   local   meetmemo_claude:<uid>                  { on, at }  account-wide Claude switch; adopted
//           by a meeting that has no Auto-answer entry of its own yet
//   session meetmemo_live:<uid>:<meetingId>        { uid, meetingId, cards: { [questionId]: card } }
//
// Work stops on sign-out or account switch, when Auto-answer is turned off, when the tab moves to
// another meeting, and when the meeting turns out to be deleted. A failed answer never affects
// transcript saving: the two share nothing but the meeting mapping.
(() => {
  const AA_PREFIX = 'meetmemo_autoanswer:';
  const LIVE_PREFIX = 'meetmemo_live:';
  const PREFS_KEY = 'meetmemo_prefs';
  const PORT_NAME = 'meetmemo-sync';
  const MAX_CARDS = 60;
  const MAX_QUEUED = 2; // per meeting, besides the one running; older waiting questions are dropped
  const WRITE_MS = 120; // streaming updates are batched into session storage this often
  const START_TIMEOUT_MS = 60_000; // a sleeping free-tier host can take ~50 s to wake up
  const GROWTH_WORDS = 3;
  const ENABLE_SLACK_MS = 1500;
  // Claude switch in the Meet panel (sync/claude-dock.js): account-wide, so turning Claude on
  // once covers later meetings too. A meeting's own Auto-answer entry, when present, wins.
  const CLAUDE_PREFIX = 'meetmemo_claude:';
  const MAP_PREFIX = 'meetmemo_map:'; // sync/worker.js meeting mapping, per account + tab session
  const DOCK_CARDS = 3; // newest cards shown in the Meet panel; the live view has the rest
  const HEALTH_TTL_MS = 60_000;

  const aaKey = (uid, meetingId) => `${AA_PREFIX}${uid}:${meetingId}`;
  const claudeKey = (uid) => `${CLAUDE_PREFIX}${uid}`;
  const liveKey = (uid, meetingId) => `${LIVE_PREFIX}${uid}:${meetingId}`;
  const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
  const fail = (code, message, extra = {}) => Object.assign(new Error(message || code), { code, ...extra });

  // Server-Sent Events from a fetch Response. onEvent(name, data) returns false to stop reading.
  async function readSse(res, onEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue; // keep-alive
        if (onEvent(event, JSON.parse(data)) === false) { reader.cancel().catch(() => {}); return; }
      }
    }
  }

  function createLiveEngine({
    storage, sessionStorage, authority, sync, baseUrl, segmentDocId,
    fetchImpl = (...a) => fetch(...a), now = () => Date.now(), log = console,
    setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t),
  }) {
    const states = new Map(); // liveKey -> state (cache of session storage; this worker is the only writer)
    const loading = new Map();
    const lanes = new Map(); // liveKey -> { running: job | null, queue: [job] }
    const deleted = new Set(); // liveKey of meetings found deleted
    const dirty = new Set();
    let writeTimer = null;
    let runSeq = 0;

    // ---- state ----
    async function stateFor(uid, meetingId) {
      const key = liveKey(uid, meetingId);
      if (states.has(key)) return states.get(key);
      if (!loading.has(key)) {
        loading.set(key, (async () => {
          const stored = (await sessionStorage.get(key))[key];
          const st = stored && stored.uid === uid ? stored : { uid, meetingId, cards: {} };
          if (!states.has(key)) states.set(key, st);
          return states.get(key);
        })().finally(() => loading.delete(key)));
      }
      return loading.get(key);
    }

    function flush() {
      writeTimer = null;
      const out = {};
      for (const key of dirty) if (states.has(key)) out[key] = states.get(key);
      dirty.clear();
      if (Object.keys(out).length) sessionStorage.set(out).catch((e) => log.warn('[MeetMemo live] could not store cards', e?.message));
    }
    function touch(st, { now: immediate = false } = {}) {
      st.updatedAt = now();
      const ids = Object.keys(st.cards);
      if (ids.length > MAX_CARDS) {
        ids.sort((a, b) => (st.cards[a].question?.ts || 0) - (st.cards[b].question?.ts || 0));
        for (const id of ids.slice(0, ids.length - MAX_CARDS)) if (!['checking', 'answering'].includes(st.cards[id].status)) delete st.cards[id];
      }
      dirty.add(liveKey(st.uid, st.meetingId));
      if (immediate) { if (writeTimer) clearTimer(writeTimer); flush(); } else if (!writeTimer) writeTimer = setTimer(flush, WRITE_MS);
    }

    async function dropState(uid, meetingId) {
      const key = liveKey(uid, meetingId);
      states.delete(key);
      dirty.delete(key);
      await sessionStorage.remove(key);
    }

    // After a worker restart nothing is streaming any more: in-flight cards become retryable
    // errors (or disappear if no card was shown yet). Nothing is re-sent automatically.
    async function recover() {
      const all = await sessionStorage.get(null);
      const out = {};
      for (const [k, st] of Object.entries(all)) {
        if (!k.startsWith(LIVE_PREFIX) || !st?.cards || states.has(k)) continue;
        let changed = false;
        for (const [id, c] of Object.entries(st.cards)) {
          if (c.status === 'checking') { delete st.cards[id]; changed = true; }
          else if (c.status === 'answering') { Object.assign(c, { status: 'error', errorCode: 'stream_cut', shown: true }); changed = true; }
        }
        if (changed) out[k] = st;
      }
      if (Object.keys(out).length) await sessionStorage.set(out);
    }

    // ---- auth / http ----
    async function authFor(uid, forceRefresh = false) {
      const auth = await authority.getAuth(forceRefresh ? { forceRefresh: true } : undefined);
      if (!auth) throw fail('signed_out');
      if (auth.user.uid !== uid) throw fail('account_changed');
      return auth;
    }

    async function getJson(uid, path) {
      const { idToken } = await authFor(uid);
      const res = await fetchImpl(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${idToken}` }, signal: AbortSignal.timeout(START_TIMEOUT_MS) });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    }

    // ---- lanes (bounded work per meeting) ----
    function enqueue(job) {
      const key = liveKey(job.uid, job.meetingId);
      let lane = lanes.get(key);
      if (!lane) { lane = { running: null, queue: [] }; lanes.set(key, lane); }
      if (lane.running?.questionId === job.questionId || lane.queue.some((j) => j.questionId === job.questionId)) return;
      lane.queue.push(job);
      while (lane.queue.length > MAX_QUEUED) lane.queue.shift(); // newest questions matter most
      pump(key);
    }

    function pump(key) {
      const lane = lanes.get(key);
      if (!lane || lane.running || !lane.queue.length) return;
      const job = lane.queue.shift();
      lane.running = job;
      run(job).catch((e) => log.warn('[MeetMemo live] answer failed', e?.message)).finally(() => {
        if (lanes.get(key) === lane) { lane.running = null; pump(key); }
      });
    }

    // Stops everything for one meeting. reason: 'off' | 'account' | 'meeting' | 'deleted'
    function cancelMeeting(key, reason) {
      const lane = lanes.get(key);
      if (!lane) return;
      lane.queue = [];
      if (lane.running) { lane.running.cancelled = reason; lane.running.controller?.abort(); }
    }

    // ---- one request ----
    async function run(job) {
      const runId = ++runSeq;
      job.runId = runId;
      job.controller = new AbortController();
      const { uid, meetingId, questionId } = job;
      const key = liveKey(uid, meetingId);
      const st = await stateFor(uid, meetingId);
      const live = () => !job.cancelled && lanes.get(key)?.running === job && states.get(key) === st;
      const prev = st.cards[questionId];
      const card = {
        questionId,
        question: job.question,
        context: job.context,
        status: 'checking',
        answer: '',
        sources: [],
        errorCode: null,
        shown: prev?.shown || false,
        words: words(job.question.text),
        timings: { settledAt: job.settledAt || null, sentAt: now(), cardAt: null, firstTextAt: null, doneAt: null },
      };
      st.cards[questionId] = card;
      touch(st, { now: true });

      const finishError = (code, { shown = card.shown, message = null } = {}) => {
        if (!shown) { delete st.cards[questionId]; touch(st, { now: true }); return; }
        Object.assign(card, { status: 'error', errorCode: code, errorMessage: message, shown: true });
        card.timings.doneAt = now();
        touch(st, { now: true });
      };

      let reauthed = false;
      for (;;) {
        let res;
        const startTimer = setTimer(() => { job.timedOut = true; job.controller.abort(); }, START_TIMEOUT_MS);
        try {
          const { idToken } = await authFor(uid, reauthed);
          if (!live()) return;
          const prefs = (await storage.get(PREFS_KEY))[PREFS_KEY] || {};
          res = await fetchImpl(`${baseUrl}/v1/meetings/${encodeURIComponent(meetingId)}/ai/live/answer`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: JSON.stringify({
              questionId,
              question: job.question,
              context: job.context,
              ...(prefs.aiLanguage ? { answerLanguage: prefs.aiLanguage } : {}),
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              ...(job.retry ? { retry: true } : {}),
            }),
            signal: job.controller.signal,
          });
        } catch (err) {
          clearTimer(startTimer);
          if (!live()) return onCancelled(job, st, card);
          if (err.code === 'signed_out' || err.code === 'account_changed') { delete st.cards[questionId]; touch(st, { now: true }); return; }
          return finishError(job.timedOut ? 'ai_timeout' : 'network', { shown: true });
        }
        clearTimer(startTimer);
        if (!live()) return onCancelled(job, st, card);
        if (res.status === 401 && !reauthed) { reauthed = true; continue; }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (res.status === 404) return onNotFound(job, st, card, body, finishError);
          if (res.status === 409) { delete st.cards[questionId]; touch(st, { now: true }); refreshLater(uid, meetingId); return; } // another delivery owns it
          return finishError(body.error || (res.status === 503 ? 'ai_unavailable' : 'ai_failed'), { shown: true, message: body.message || null });
        }
        if (!(res.headers?.get('content-type') || '').includes('event-stream')) {
          // Already decided earlier (re-delivery, revision, restart): adopt the stored result.
          const body = await res.json().catch(() => ({}));
          adopt(st, body.card);
          return;
        }
        let ended = false;
        try {
          await readSse(res, (event, data) => {
            if (!live()) return false;
            if (event === 'card') {
              card.status = 'answering';
              card.shown = true;
              card.timings.cardAt = now();
              touch(st, { now: true });
            } else if (event === 'delta') {
              if (!card.timings.firstTextAt) {
                card.timings.firstTextAt = now();
                const t = card.timings;
                if (t.settledAt) log.info(`[MeetMemo live] latency: settled→card ${t.cardAt - t.settledAt} ms, settled→first text ${t.firstTextAt - t.settledAt} ms`);
              }
              card.answer += data.text;
              touch(st);
            } else if (event === 'sources') {
              card.sources = Array.isArray(data.ids) ? data.ids.filter((x) => typeof x === 'string') : [];
            } else if (event === 'done') {
              ended = true;
              card.timings.doneAt = now();
              if (data.status === 'skipped') { card.status = 'skipped'; card.answer = ''; } else card.status = 'answered';
              touch(st, { now: true });
            } else if (event === 'error') {
              ended = true;
              if (data.code === 'not_found') { meetingGone(job); return false; }
              // Shown even before a decision (provider timeout, busy): the user can retry it.
              finishError(data.code || 'ai_failed', { shown: true, message: data.message || null });
            }
            return true;
          });
        } catch {
          if (!live()) return onCancelled(job, st, card);
        }
        if (!live() && !ended) return onCancelled(job, st, card);
        if (!ended) finishError('stream_cut');
        return;
      }
    }

    function onCancelled(job, st, card) {
      if (states.get(liveKey(job.uid, job.meetingId)) !== st) return;
      if (job.cancelled === 'deleted' || job.cancelled === 'account') return;
      if (card.status === 'checking' || !card.shown) delete st.cards[card.questionId];
      else if (card.status === 'answering') Object.assign(card, { status: 'error', errorCode: 'stopped', shown: true });
      touch(st, { now: true });
    }

    function adopt(st, server) {
      if (!server?.questionId) return;
      const local = st.cards[server.questionId];
      if (server.status === 'answered' || server.status === 'error') {
        st.cards[server.questionId] = {
          ...(local || {}), questionId: server.questionId, question: server.question || local?.question, status: server.status,
          answer: server.answer || '', sources: server.sources || [], errorCode: server.errorCode || null, shown: true,
          words: words(server.question?.text), timings: local?.timings || {},
        };
      } else if (server.status === 'skipped') {
        st.cards[server.questionId] = { ...(local || {}), questionId: server.questionId, question: server.question || local?.question, status: 'skipped', answer: '', shown: false, words: words(server.question?.text) };
      } else if (local) delete st.cards[server.questionId];
      touch(st, { now: true });
    }

    // 404 from the AI route: either this server predates the route, or the meeting is gone for
    // this account. Reconcile with the meetings API before deciding; never retry blindly.
    async function onNotFound(job, st, card, body, finishError) {
      let meeting;
      try { meeting = await getJson(job.uid, `/v1/meetings/${encodeURIComponent(job.meetingId)}`); } catch { return finishError('network', { shown: true }); }
      if (meeting.status === 200) return finishError('route_not_found', { shown: true });
      if (meeting.status === 404) return meetingGone(job);
      return finishError(body.error || 'ai_failed', { shown: true });
    }

    // The meeting was deleted (or belongs to someone else now): respect it. Stop all AI work for
    // it, forget its cards and its Auto-answer setting, and let the sync engine handle the
    // mapping as it already does for uploads.
    async function meetingGone(job) {
      const key = liveKey(job.uid, job.meetingId);
      deleted.add(key);
      cancelMeeting(key, 'deleted');
      await dropState(job.uid, job.meetingId);
      await storage.remove(aaKey(job.uid, job.meetingId));
      if (job.tab) await sync.forgetMeeting(job.uid, job.tab, job.meetingId);
    }

    function refreshLater(uid, meetingId) {
      setTimer(async () => {
        try {
          const r = await getJson(uid, `/v1/meetings/${encodeURIComponent(meetingId)}/ai/live`);
          if (r.status !== 200) return;
          const st = await stateFor(uid, meetingId);
          for (const c of r.body.cards || []) if (!st.cards[c.questionId] || st.cards[c.questionId].status === 'checking') adopt(st, c);
        } catch { /* best effort */ }
      }, 8000);
    }

    // ---- entry points ----
    async function handleCandidate({ tab, meeting, candidate }) {
      if (!candidate?.sourceId || !String(candidate.text || '').trim()) return;
      const user = await authority.getUser();
      if (!user) return;
      // The first question of a new meeting waits here for the canonical meeting.
      let mapping;
      try { mapping = await sync.ensureMeeting(user.uid, tab, meeting); } catch { return; }
      const key = liveKey(user.uid, mapping.meetingId);
      if (deleted.has(key)) return;
      const ak = aaKey(user.uid, mapping.meetingId);
      let aa = (await storage.get(ak))[ak];
      if (!aa) {
        // No choice made for this meeting yet: follow the account-wide Claude switch, counting
        // from when it was switched on, and record it so the live view shows the same state.
        const g = (await storage.get(claudeKey(user.uid)))[claudeKey(user.uid)];
        if (g?.on) { aa = { on: true, at: g.at || 0 }; await storage.set({ [ak]: aa }); }
      }
      if (!aa?.on) return;
      if ((candidate.ts || 0) < (aa.at || 0) - ENABLE_SLACK_MS) return; // asked before Auto-answer was on
      if ((await authority.getUser())?.uid !== user.uid) return; // account switched meanwhile
      const toSeg = (sourceId) => segmentDocId(String(sourceId), mapping.scheme);
      const questionId = await toSeg(candidate.sourceId);
      const context = [];
      for (const l of (candidate.context || []).slice(-12)) {
        const text = String(l.text || '').trim().slice(0, 2000);
        if (text) context.push({ id: await toSeg(l.sourceId), ...(l.speaker ? { speaker: String(l.speaker).slice(0, 200) } : {}), ts: Math.floor(l.ts || 0), text });
      }
      const st = await stateFor(user.uid, mapping.meetingId);
      const existing = st.cards[questionId];
      if (existing) {
        if (['checking', 'answering', 'answered', 'error'].includes(existing.status)) return; // errors retry on request only
        if (existing.status === 'skipped' && words(candidate.text) < (existing.words || 0) + GROWTH_WORDS) return;
      }
      enqueue({
        uid: user.uid, meetingId: mapping.meetingId, tab, questionId,
        question: { text: String(candidate.text).slice(0, 2000), ...(candidate.speaker ? { speaker: String(candidate.speaker).slice(0, 200) } : {}), ts: Math.floor(candidate.ts || now()) },
        context, settledAt: candidate.settledAt, retry: false,
      });
      return { meetingKey: key };
    }

    async function retry({ meetingId, questionId, question }) {
      const user = await authority.getUser();
      if (!user || !meetingId || !questionId) return;
      const key = liveKey(user.uid, meetingId);
      if (deleted.has(key)) return;
      const st = await stateFor(user.uid, meetingId);
      const card = st.cards[questionId];
      const q = card?.question || question;
      if (!q?.text || card?.status === 'checking' || card?.status === 'answering') return;
      enqueue({ uid: user.uid, meetingId, tab: null, questionId, question: q, context: card?.context || [], settledAt: null, retry: true });
    }

    function onAccount(user) {
      for (const key of [...lanes.keys()]) if (!user || !key.startsWith(`${LIVE_PREFIX}${user.uid}:`)) { cancelMeeting(key, 'account'); lanes.delete(key); }
      for (const key of [...states.keys()]) if (!user || !key.startsWith(`${LIVE_PREFIX}${user.uid}:`)) states.delete(key);
    }

    function onStorageChange(changes, area) {
      if (area !== 'local') return;
      for (const [k, ch] of Object.entries(changes)) {
        if (!k.startsWith(AA_PREFIX) || ch.newValue?.on) continue;
        cancelMeeting(`${LIVE_PREFIX}${k.slice(AA_PREFIX.length)}`, 'off'); // turned off or removed
      }
    }

    // ---- Claude in the Meet panel (sync/claude-dock.js) ----
    const dockListeners = new Set();
    const notifyDock = () => dockListeners.forEach((f) => { try { f(); } catch { /* listener gone */ } });
    const serverInfo = new Map(); // meetingId -> { enabled: boolean | null }
    let health = null; // { at, live: true | false | null (unknown) }

    // /healthz names the features the deployed backend has; a build without "ai-live" is an
    // outdated deployment, which is reported as such instead of as a per-question failure.
    async function serverHasLive() {
      if (health && now() - health.at < HEALTH_TTL_MS) return health.live;
      let live = null;
      try {
        const res = await fetchImpl(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(START_TIMEOUT_MS) });
        const body = await res.json().catch(() => ({}));
        if (res.ok) live = Array.isArray(body.features) && body.features.includes('ai-live');
      } catch { /* unreachable or asleep: unknown, not outdated */ }
      health = { at: now(), live };
      return live;
    }

    async function mappingFor(uid, tab) {
      const k = `${MAP_PREFIX}${uid}:${tab}`;
      return (await storage.get(k))[k] || null;
    }

    // Asks the backend once per meeting whether AI is configured, and restores saved cards.
    function loadServerInfo(uid, meetingId) {
      if (serverInfo.has(meetingId)) return;
      serverInfo.set(meetingId, { enabled: null });
      getJson(uid, `/v1/meetings/${encodeURIComponent(meetingId)}/ai/live`).then(async (r) => {
        if (r.status === 404 && r.body?.error === 'route_not_found') health = { at: now(), live: false };
        if (r.status !== 200) { if (r.status >= 500 || r.status === 401) serverInfo.delete(meetingId); notifyDock(); return; }
        serverInfo.set(meetingId, { enabled: r.body.enabled !== false });
        const st = await stateFor(uid, meetingId);
        let changed = false;
        for (const c of r.body.cards || []) if (!st.cards[c.questionId]) { adopt(st, c); changed = true; }
        if (!changed) notifyDock();
      }).catch(() => { serverInfo.delete(meetingId); });
    }

    const visible = (c) => c.status === 'answering' || c.status === 'answered' || (c.status === 'error' && c.shown !== false);

    async function dockState(tab) {
      const user = await authority.getUser();
      if (!user) return { signedIn: false };
      const uid = user.uid;
      const [mapping, g, live] = await Promise.all([mappingFor(uid, tab), storage.get(claudeKey(uid)), serverHasLive()]);
      const out = { signedIn: true, on: !!g[claudeKey(uid)]?.on, meetingId: null, serverOutdated: live === false, enabled: null, cards: [] };
      if (!mapping?.meetingId) return out;
      const { meetingId } = mapping;
      out.meetingId = meetingId;
      const aa = (await storage.get(aaKey(uid, meetingId)))[aaKey(uid, meetingId)];
      if (aa) out.on = !!aa.on;
      if (!out.serverOutdated) loadServerInfo(uid, meetingId);
      out.enabled = serverInfo.get(meetingId)?.enabled ?? null;
      const st = await stateFor(uid, meetingId);
      out.cards = Object.values(st.cards).filter(visible)
        .sort((a, b) => (b.question?.ts || 0) - (a.question?.ts || 0))
        .slice(0, DOCK_CARDS)
        .map((c) => ({ questionId: c.questionId, status: c.status, question: c.question, answer: c.answer || '', errorCode: c.errorCode || null }));
      return out;
    }

    // The Meet panel's Claude switch: account-wide, and applied to this meeting at once. Turning
    // it on before the meeting exists on the backend creates it (the user asked for answers).
    async function dockSet(tab, meeting, on) {
      const user = await authority.getUser();
      if (!user) return false;
      const at = now();
      await storage.set({ [claudeKey(user.uid)]: { on: !!on, at } });
      let mapping = await mappingFor(user.uid, tab);
      if (!mapping && on && meeting?.sessionId) {
        try { mapping = await sync.ensureMeeting(user.uid, tab, meeting); } catch { mapping = null; } // adopted on the first question
      }
      if ((await authority.getUser())?.uid !== user.uid) return false;
      if (mapping?.meetingId) await storage.set({ [aaKey(user.uid, mapping.meetingId)]: { on: !!on, at } });
      return true;
    }

    const onDockChange = (f) => { dockListeners.add(f); return () => dockListeners.delete(f); };

    return { handleCandidate, retry, onAccount, onStorageChange, cancelMeeting, recover, flush, dockState, dockSet, onDockChange, _lanes: lanes, _states: states };
  }

  self.MeetMemoLive = { createLiveEngine, readSse, aaKey, liveKey, claudeKey, AA_PREFIX, LIVE_PREFIX, CLAUDE_PREFIX };

  // ---- wiring (skipped by tests that load this file with MEETMEMO_SYNC_NO_AUTOSTART) ----
  if (self.MEETMEMO_SYNC_NO_AUTOSTART || !self.chrome?.runtime?.onConnect || !self.MeetMemoSync) return;
  const { authority, engine: sync } = self.MeetMemoSync;
  const live = createLiveEngine({
    storage: chrome.storage.local,
    sessionStorage: chrome.storage.session,
    authority,
    sync,
    baseUrl: self.MEETMEMO_CONFIG.apiBaseUrl,
    segmentDocId: self.MeetMemoSegmentId.segmentDocId,
  });
  self.MeetMemoSync.live = live;

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME || port.sender?.id !== chrome.runtime.id) return;
    let current = null; // the meeting this tab last asked about
    port.onMessage.addListener(async (msg) => {
      if (msg?.type !== 'candidate' || !msg.meeting?.sessionId || !msg.candidate) return;
      try {
        const r = await live.handleCandidate({ tab: msg.meeting.sessionId, meeting: msg.meeting, candidate: msg.candidate });
        if (r?.meetingKey && current && current !== r.meetingKey) live.cancelMeeting(current, 'meeting'); // tab moved to another meeting
        if (r?.meetingKey) current = r.meetingKey;
      } catch (err) {
        console.warn('[MeetMemo live] candidate dropped:', err?.message);
      }
    });
  });

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== 'meetmemo-live-retry' || sender.id !== chrome.runtime.id) return;
    live.retry(msg).catch((e) => console.warn('[MeetMemo live] retry failed', e?.message));
  });
  // Claude in the Meet panel: the tab watches its meeting's state and flips the switch through
  // this port; the worker stays the only reader of the session store and the only writer.
  const docks = new Set(); // { port, tab, meeting }
  let pushTimer = null;
  async function push(d) {
    if (!d.tab) return;
    try {
      const state = await live.dockState(d.tab);
      if (docks.has(d)) d.port.postMessage({ type: 'state', ...state });
    } catch (err) {
      if (docks.has(d)) console.warn('[MeetMemo live] Claude panel update failed:', err?.message);
    }
  }
  function pushAll() {
    if (pushTimer || !docks.size) return;
    pushTimer = setTimeout(() => { pushTimer = null; docks.forEach(push); }, 150); // streaming writes are batched too
  }
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'meetmemo-claude' || port.sender?.id !== chrome.runtime.id) return;
    const d = { port, tab: null, meeting: null };
    docks.add(d);
    port.onDisconnect.addListener(() => docks.delete(d));
    port.onMessage.addListener(async (msg) => {
      try {
        if (msg?.type === 'watch' && msg.meeting?.sessionId) {
          d.tab = String(msg.meeting.sessionId);
          d.meeting = msg.meeting;
          await push(d);
        } else if (msg?.type === 'set' && d.tab) {
          await live.dockSet(d.tab, d.meeting, msg.on === true);
          await push(d);
        } else if (msg?.type === 'retry' && d.tab && msg.questionId) {
          const st = await live.dockState(d.tab);
          if (st.meetingId) await live.retry({ meetingId: st.meetingId, questionId: String(msg.questionId) });
        }
      } catch (err) {
        console.warn('[MeetMemo live] Claude panel request failed:', err?.message);
      }
    });
  });
  const DOCK_KEYS = [AA_PREFIX, LIVE_PREFIX, CLAUDE_PREFIX, MAP_PREFIX];
  chrome.storage.onChanged.addListener((changes) => {
    if (Object.keys(changes).some((k) => DOCK_KEYS.some((p) => k.startsWith(p)))) pushAll();
  });
  live.onDockChange(pushAll);

  authority.onChange((user) => { live.onAccount(user); pushAll(); });
  chrome.storage.onChanged.addListener((changes, area) => live.onStorageChange(changes, area));
  live.recover().catch((e) => console.warn('[MeetMemo live] recovery failed', e?.message));
})();

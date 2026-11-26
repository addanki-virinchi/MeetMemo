// Thin client for the MeetMemo backend. Attaches the Firebase ID token; holds no secrets.
// Only public values belong in config (API base URL). Never put service-account data here.
const REQUEST_TIMEOUT_MS = 60_000; // a sleeping free-tier host can take ~50 s to wake up
const SEGMENT_PAGE = 1000; // backend maximum per page
const MAX_SEGMENT_PAGES = 200; // safety stop (200k lines) against a misbehaving cursor

// Error from a failed response. An older server answers routes it does not have with a bare
// {error:'not_found'} (no message), the same code as "meeting not found for this account"; that
// case is reported as route_not_found so a missing endpoint is never shown as a missing meeting.
async function httpFailure(res) {
  const err = await res.json().catch(() => ({}));
  const code = res.status === 404 && (err.error === 'route_not_found' || (err.error === 'not_found' && !err.message)) ? 'route_not_found' : err.error;
  return Object.assign(new Error(err.message || `HTTP ${res.status}`), { status: res.status, code });
}

export function createApiClient({ baseUrl, authProvider, fetchImpl = (...a) => fetch(...a) }) {
  // expectUid: refuse to send another account's token if the session changed underneath
  // the caller (e.g. a view that loaded for account A while B just signed in).
  async function request(path, { method = 'GET', body, expectUid, timeoutMs = REQUEST_TIMEOUT_MS } = {}, retried = false) {
    const auth = await authProvider.getAuth(retried);
    if (!auth?.idToken) throw Object.assign(new Error('Not signed in'), { code: 'unauthenticated' });
    if (expectUid && auth.user?.uid !== expectUid) throw Object.assign(new Error('Signed-in account changed'), { code: 'account_changed' });
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${auth.idToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 && !retried) {
      // The backend rejected the token: refresh it once and retry before reporting a failure.
      return request(path, { method, body, expectUid, timeoutMs }, true);
    }
    if (!res.ok) throw await httpFailure(res);
    return res.status === 204 ? null : res.json();
  }

  const id = (x) => encodeURIComponent(x);

  // Ask Meet Memo: POST that answers with Server-Sent Events (EventSource cannot send the
  // Authorization header, so the stream is read from fetch). onEvent(name, data) gets meta,
  // cite, delta, done and error events. The 60 s timeout covers only the wait for the response
  // to start (a sleeping server can take that long); `signal` stops the stream at any time.
  async function askMeeting(meetingId, body, { expectUid, signal, onEvent } = {}, retried = false) {
    const auth = await authProvider.getAuth(retried);
    if (!auth?.idToken) throw Object.assign(new Error('Not signed in'), { code: 'unauthenticated' });
    if (expectUid && auth.user?.uid !== expectUid) throw Object.assign(new Error('Signed-in account changed'), { code: 'account_changed' });
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal.reason);
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    const startTimer = setTimeout(() => ctrl.abort(Object.assign(new Error('Timed out'), { name: 'TimeoutError' })), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${baseUrl}/v1/meetings/${id(meetingId)}/ai/ask`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.idToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(startTimer);
      if (res.status === 401 && !retried) return askMeeting(meetingId, body, { expectUid, signal, onEvent }, true);
      if (!res.ok) throw await httpFailure(res);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let ended = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
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
          if (!data) continue; // keep-alive comment
          if (event === 'done' || event === 'error') ended = true;
          onEvent?.(event, JSON.parse(data));
        }
      }
      if (!ended) throw Object.assign(new Error('The answer was cut off'), { code: 'stream_cut' });
      return null;
    } finally {
      clearTimeout(startTimer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  function listSegmentsPage(meetingId, { after, limit = SEGMENT_PAGE, expectUid } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (after) q.set('after', after);
    return request(`/v1/meetings/${id(meetingId)}/segments?${q}`, { expectUid });
  }

  return {
    registerUser: (opts) => request('/v1/users/me', { method: 'POST', ...opts }),
    createMeeting: (m) => request('/v1/meetings', { method: 'POST', body: m }),
    listMeetings: (after, opts) => request(`/v1/meetings${after ? `?after=${id(after)}` : ''}`, opts),
    getMeeting: (meetingId, opts) => request(`/v1/meetings/${id(meetingId)}`, opts),
    listSegmentsPage,
    // Every segment of a meeting, page by page. onPage(itemsSoFar) reports progress.
    // Returns { items, complete } — complete is false only if the safety stop was hit.
    async listAllSegments(meetingId, { expectUid, onPage, signal } = {}) {
      const items = [];
      let after = null;
      for (let page = 0; page < MAX_SEGMENT_PAGES; page += 1) {
        if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
        const r = await listSegmentsPage(meetingId, { after, expectUid });
        items.push(...r.items);
        onPage?.(items);
        if (!r.next) return { items, complete: true };
        after = r.next;
      }
      return { items, complete: false };
    },
    appendSegments: (meetingId, segments) => request(`/v1/meetings/${id(meetingId)}/segments`, { method: 'POST', body: { segments } }),
    deleteMeeting: (meetingId) => request(`/v1/meetings/${id(meetingId)}`, { method: 'DELETE' }),
    // Ask Meet Memo
    askMeeting,
    listAiThreads: (meetingId, opts) => request(`/v1/meetings/${id(meetingId)}/ai/threads`, opts),
    getAiThread: (meetingId, threadId, opts) => request(`/v1/meetings/${id(meetingId)}/ai/threads/${id(threadId)}`, opts),
    deleteAiThread: (meetingId, threadId, opts) => request(`/v1/meetings/${id(meetingId)}/ai/threads/${id(threadId)}`, { method: 'DELETE', ...opts }),
    // Live auto-answer: completed cards for one meeting (answers stream through the worker)
    listLiveCards: (meetingId, opts) => request(`/v1/meetings/${id(meetingId)}/ai/live`, opts),
    // Meeting context documents (Meetings page); the Claude tab's assistant reads the active ones.
    listContextDocs: (opts) => request('/v1/context-docs', opts),
    // PDFs and images are read by Claude on the server, which can take a few minutes for long files.
    uploadContextDoc: (body, opts) => request('/v1/context-docs', { method: 'POST', body, timeoutMs: 240_000, ...opts }),
    updateContextDoc: (docId, body, opts) => request(`/v1/context-docs/${id(docId)}`, { method: 'PATCH', body, ...opts }),
    deleteContextDoc: (docId, opts) => request(`/v1/context-docs/${id(docId)}`, { method: 'DELETE', ...opts }),
  };
}

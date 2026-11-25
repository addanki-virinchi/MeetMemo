// Thin client for the MeetMemo backend. Attaches the Firebase ID token; holds no secrets.
// Only public values belong in config (API base URL). Never put service-account data here.
const REQUEST_TIMEOUT_MS = 60_000; // a sleeping free-tier host can take ~50 s to wake up
const SEGMENT_PAGE = 1000; // backend maximum per page
const MAX_SEGMENT_PAGES = 200; // safety stop (200k lines) against a misbehaving cursor

export function createApiClient({ baseUrl, authProvider, fetchImpl = (...a) => fetch(...a) }) {
  // expectUid: refuse to send another account's token if the session changed underneath
  // the caller (e.g. a view that loaded for account A while B just signed in).
  async function request(path, { method = 'GET', body, expectUid } = {}, retried = false) {
    const auth = await authProvider.getAuth(retried);
    if (!auth?.idToken) throw Object.assign(new Error('Not signed in'), { code: 'unauthenticated' });
    if (expectUid && auth.user?.uid !== expectUid) throw Object.assign(new Error('Signed-in account changed'), { code: 'account_changed' });
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${auth.idToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401 && !retried) {
      // The backend rejected the token: refresh it once and retry before reporting a failure.
      return request(path, { method, body, expectUid }, true);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(new Error(err.message || `HTTP ${res.status}`), { status: res.status, code: err.error });
    }
    return res.status === 204 ? null : res.json();
  }

  const id = (x) => encodeURIComponent(x);

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
  };
}

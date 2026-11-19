// Thin client for the MeetMemo backend. Attaches the Firebase ID token; holds no secrets.
// Only public values belong in config (API base URL). Never put service-account data here.
export function createApiClient({ baseUrl, authProvider }) {
  async function request(path, { method = 'GET', body } = {}) {
    const token = await authProvider.getIdToken();
    if (!token) throw Object.assign(new Error('Not signed in'), { code: 'unauthenticated' });
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(new Error(err.message || `HTTP ${res.status}`), { status: res.status, code: err.error });
    }
    return res.status === 204 ? null : res.json();
  }
  return {
    registerUser: () => request('/v1/users/me', { method: 'POST' }),
    createMeeting: (m) => request('/v1/meetings', { method: 'POST', body: m }),
    listMeetings: (after) => request(`/v1/meetings${after ? `?after=${encodeURIComponent(after)}` : ''}`),
    appendSegments: (id, segments) => request(`/v1/meetings/${id}/segments`, { method: 'POST', body: { segments } }),
    deleteMeeting: (id) => request(`/v1/meetings/${id}`, { method: 'DELETE' }),
  };
}

// TEST_MODE provider: name + email + password via the backend /v1/auth routes.
// Same interface as googleAuthProvider, so switching is a one-line change in createAuthProvider().
// Tokens are kept in chrome.storage.local (never the password).
const KEY = 'meetmemo_session';

export function createManualAuthProvider({ baseUrl }) {
  const listeners = new Set();
  const notify = (u) => listeners.forEach((cb) => cb(u));

  const load = async () => (await chrome.storage.local.get(KEY))[KEY] || null;
  const save = (s) => chrome.storage.local.set({ [KEY]: s });

  async function post(path, body) {
    const res = await fetch(`${baseUrl}/v1/auth/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || `HTTP ${res.status}`), { status: res.status, code: data.error });
    return data;
  }

  const toSession = (d) => ({ ...d, expiresAt: Date.now() + d.expiresIn * 1000 });
  const toUser = (s) => ({ uid: s.uid, email: s.email, displayName: s.displayName });

  return {
    async signUp({ name, email, password }) {
      const s = toSession(await post('signup', { name, email, password }));
      await save(s); notify(toUser(s)); return toUser(s);
    },
    async signIn({ email, password }) {
      const s = toSession(await post('login', { email, password }));
      await save(s); notify(toUser(s)); return toUser(s);
    },
    async signOut() { await chrome.storage.local.remove(KEY); notify(null); },
    async getIdToken(forceRefresh = false) {
      let s = await load();
      if (!s) return null;
      if (forceRefresh || s.expiresAt - Date.now() < 60_000) {
        try {
          s = { ...s, ...toSession(await post('refresh', { refreshToken: s.refreshToken })) };
          await save(s);
        } catch { await this.signOut(); return null; }
      }
      return s.idToken;
    },
    onAuthStateChanged(cb) {
      listeners.add(cb);
      load().then((s) => cb(s ? toUser(s) : null));
      return () => listeners.delete(cb);
    },
  };
}

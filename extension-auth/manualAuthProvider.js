// Auth provider: email + password and Google sign-in, both through the backend /v1/auth routes
// (which relay Firebase Authentication).
//
// This page-side provider never writes the session itself. Credentials are exchanged for
// tokens here, then the service worker's session authority (extension-auth/sessionAuthority.js)
// stores them, refreshes them and removes them. Identity changes are observed through
// chrome.storage, so every open page sees logins, logouts and account switches made anywhere.
// Tokens are kept in chrome.storage.local (never the password).
import './session.js';

const { subscribe, currentUser } = self.MeetMemoSession;
const REQUEST_TIMEOUT_MS = 60_000; // a sleeping free-tier host can take ~50 s to wake up

export function createManualAuthProvider({ baseUrl, chromeApi = self.chrome, fetchImpl = (...a) => fetch(...a) }) {
  let seq = 0;
  // One request per short-lived port to the service worker's session authority.
  function call(op, extra) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      let port;
      try {
        port = chromeApi.runtime.connect({ name: 'meetmemo-auth' });
      } catch (err) {
        reject(Object.assign(new Error('The extension was reloaded. Close and reopen this page.'), { code: 'no_worker' }));
        return;
      }
      port.onMessage.addListener((res) => {
        if (res?.id !== id) return;
        port.disconnect();
        if (res.ok) resolve(res.value);
        else reject(Object.assign(new Error(res.error?.message || 'Request failed'), res.error || {}));
      });
      port.onDisconnect.addListener(() => {
        void chromeApi.runtime.lastError;
        reject(Object.assign(new Error('The extension background stopped responding. Try again.'), { code: 'no_worker' }));
      });
      port.postMessage({ id, op, ...extra });
    });
  }

  async function post(path, body) {
    const res = await fetchImpl(`${baseUrl}/v1/auth/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || `HTTP ${res.status}`), { status: res.status, code: data.error });
    return data;
  }

  return {
    async signUp({ name, email, password }) {
      return call('commitLogin', { session: await post('signup', { name, email, password }) });
    },
    async signIn({ email, password }) {
      return call('commitLogin', { session: await post('login', { email, password }) });
    },
    // Runs inside the service worker; resolves once the Google window is done.
    signInWithGoogle: () => call('googleSignIn'),
    signOut: () => call('signOut'),
    // Token for the current session, refreshed centrally when close to expiry.
    async getIdToken(forceRefresh = false) {
      return (await call('getAuth', { forceRefresh }))?.idToken ?? null;
    },
    // { idToken, user } so callers can tell which account a token belongs to.
    getAuth: (forceRefresh = false) => call('getAuth', { forceRefresh }),
    getUser: () => currentUser(chromeApi),
    setProfileState: (sid, state, message) => call('setProfileState', { sid, state, message }),
    // cb(user|null) now and on every identity change; returns unsubscribe.
    onAuthStateChanged: (cb) => subscribe(cb, chromeApi),
  };
}

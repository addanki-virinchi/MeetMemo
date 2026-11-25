// Session authority: the single writer of the local session record (service worker only).
//
// Every mutation (login commit, logout, token refresh, profile state) runs through one
// serialized queue and is checked against the session id (sid) that started it, so:
//   - a refresh that was in flight during logout cannot restore the old session;
//   - a refresh for account A cannot replace account B after a switch;
//   - concurrent refreshes for the same session share one request.
// Extension pages reach it through the "meetmemo-auth" port (see manualAuthProvider.js);
// sync/worker.js calls it directly. Requires extension-auth/session.js to be loaded first.
(() => {
  const { KEY, STATUS_KEY, sidOf, toUser } = self.MeetMemoSession;
  const MSG = 'meetmemo-auth';
  const REFRESH_MARGIN_MS = 60_000;
  const REQUEST_TIMEOUT_MS = 60_000; // a sleeping free-tier host can take ~50 s to wake up

  const fail = (code, message, status) => Object.assign(new Error(message), { code, status });

  function createSessionAuthority({ storage, fetchImpl = (...a) => fetch(...a), baseUrl, now = () => Date.now(), newId = () => crypto.randomUUID(), identity = self.chrome?.identity }) {
    let chain = Promise.resolve();
    // Serializes all session mutations in this context (the only writer).
    const mutate = (fn) => {
      const run = chain.then(fn, fn);
      chain = run.then(() => {}, () => {});
      return run;
    };
    const read = async () => (await storage.get(KEY))[KEY] || null;
    const refreshing = new Map(); // sid -> Promise<idToken|null>
    const listeners = new Set(); // in-context identity change hooks (sync/worker.js)
    const changed = (user) => listeners.forEach((cb) => { try { cb(user); } catch (e) { console.error(e); } });

    async function postAuth(path, body) {
      const res = await fetchImpl(`${baseUrl}/v1/auth/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw fail(data.error || 'http_error', data.message || `HTTP ${res.status}`, res.status);
      return data;
    }

    // Google sign-in. Runs here (not in the popup) because the popup closes as soon as the
    // Google window takes focus, which would abandon the flow half-way. Flow: Google OAuth
    // (implicit, id_token) via chrome.identity -> backend /v1/auth/google -> Firebase session.
    // The OAuth client id comes from the backend (/v1/auth/config), so rotating or moving it
    // is an environment-variable change on the server, never an extension release.
    async function googleSignIn() {
      if (!identity?.launchWebAuthFlow) throw fail('unsupported', 'Google sign-in is not available in this browser');
      const cfgRes = await fetchImpl(`${baseUrl}/v1/auth/config`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const cfg = await cfgRes.json().catch(() => ({}));
      if (!cfgRes.ok || !cfg.google || !cfg.googleClientId) throw fail('provider_disabled', 'Google sign-in is not configured on the server');
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      const params = new URLSearchParams({
        client_id: cfg.googleClientId,
        response_type: 'id_token',
        redirect_uri: identity.getRedirectURL(),
        scope: 'openid email profile',
        nonce,
        prompt: 'select_account',
      });
      let redirect;
      try {
        redirect = await identity.launchWebAuthFlow({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, interactive: true });
      } catch (err) {
        const msg = String(err?.message || err);
        throw fail(/did not approve|closed|cancel/i.test(msg) ? 'cancelled' : 'google_failed', /did not approve|closed|cancel/i.test(msg) ? 'Google sign-in was cancelled' : msg);
      }
      const frag = new URLSearchParams(new URL(redirect).hash.slice(1));
      const idToken = frag.get('id_token');
      if (!idToken) throw fail('google_failed', frag.get('error_description') || frag.get('error') || 'Google did not return a token');
      try {
        const payload = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (payload.nonce !== nonce) throw new Error('nonce');
      } catch {
        throw fail('google_failed', 'Google sign-in response could not be verified');
      }
      return commitLogin(await postAuth('google', { idToken }));
    }

    // Stores a freshly authenticated session (from /v1/auth/login or /signup). A new sid is
    // issued every time, so even re-logging into the same account resets per-session state.
    function commitLogin(data) {
      if (!data?.uid || !data.idToken || !data.refreshToken || !(Number(data.expiresIn) > 0)) {
        return Promise.reject(fail('invalid_session', 'The backend returned an incomplete session'));
      }
      return mutate(async () => {
        const session = {
          uid: data.uid,
          sid: newId(),
          email: data.email ?? null,
          displayName: data.displayName ?? null,
          idToken: data.idToken,
          refreshToken: data.refreshToken,
          expiresAt: now() + Number(data.expiresIn) * 1000,
          profile: { state: 'pending' },
        };
        // The previous account's sync status is dropped with the old session.
        await storage.set({ [KEY]: session });
        await storage.remove(STATUS_KEY);
        const user = toUser(session);
        changed(user);
        return user;
      });
    }

    // expectedSid lets a caller say "only if it is still this session" (e.g. a 401 cleanup).
    function signOut(expectedSid) {
      return mutate(async () => {
        const cur = await read();
        if (!cur) return false;
        if (expectedSid && sidOf(cur) !== expectedSid) return false;
        await storage.remove([KEY, STATUS_KEY]);
        changed(null);
        return true;
      });
    }

    function setProfileState(expectedSid, state, message) {
      return mutate(async () => {
        const cur = await read();
        if (!cur || sidOf(cur) !== expectedSid) return null; // account changed meanwhile: ignore
        const next = { ...cur, profile: { state, ...(message ? { message: String(message).slice(0, 300) } : {}) } };
        await storage.set({ [KEY]: next });
        const user = toUser(next);
        changed(user);
        return user;
      });
    }

    function refresh(snapshot) {
      const sid = sidOf(snapshot);
      if (refreshing.has(sid)) return refreshing.get(sid);
      const p = (async () => {
        let data;
        try {
          data = await postAuth('refresh', { refreshToken: snapshot.refreshToken });
        } catch (err) {
          // Only a rejected refresh token ends the session, and only the session it belonged to.
          // A backend that is down or slow keeps the session for a later retry.
          if (err.status === 401) { await signOut(sid); return null; }
          throw err;
        }
        return mutate(async () => {
          const cur = await read();
          // Logged out or switched while the request was in flight: discard the response.
          if (!cur || sidOf(cur) !== sid) return null;
          if (data.uid && data.uid !== cur.uid) return null;
          const next = {
            ...cur,
            idToken: data.idToken,
            refreshToken: data.refreshToken || cur.refreshToken,
            expiresAt: now() + Number(data.expiresIn) * 1000,
          };
          await storage.set({ [KEY]: next });
          return next.idToken;
        });
      })().finally(() => refreshing.delete(sid));
      refreshing.set(sid, p);
      return p;
    }

    // Returns { idToken, user } for the current session or null when signed out.
    // The returned user tells the caller which identity the token belongs to.
    async function getAuth({ forceRefresh = false } = {}) {
      const s = await read();
      if (!s) return null;
      const user = toUser(s);
      if (!forceRefresh && s.expiresAt - now() > REFRESH_MARGIN_MS) return { idToken: s.idToken, user };
      const idToken = await refresh(s);
      return idToken ? { idToken, user } : null;
    }

    async function getUser() { return toUser(await read()); }

    return {
      commitLogin, googleSignIn, signOut, setProfileState, getAuth, getUser,
      onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    };
  }

  // Port API for extension pages: one request per connection on the "meetmemo-auth" port.
  // A dedicated port (not runtime.sendMessage) keeps the bundled background.js listener,
  // which answers every runtime message, from ever replying in our place.
  // Content scripts are refused: they never need tokens.
  function installMessageHandler(authority, chromeApi = self.chrome) {
    const pagePrefix = chromeApi.runtime.getURL('');
    chromeApi.runtime.onConnect.addListener((port) => {
      if (port.name !== MSG) return;
      const reply = (m) => { try { port.postMessage(m); } catch { /* page closed */ } };
      port.onMessage.addListener((msg) => {
        const sender = port.sender || {};
        if (sender.id !== chromeApi.runtime.id || !String(sender.url || '').startsWith(pagePrefix)) {
          reply({ id: msg?.id, ok: false, error: { code: 'forbidden', message: 'Not allowed from this context' } });
          return;
        }
        const ops = {
          commitLogin: () => authority.commitLogin(msg.session),
          googleSignIn: () => authority.googleSignIn(),
          signOut: () => authority.signOut(),
          getAuth: () => authority.getAuth({ forceRefresh: !!msg.forceRefresh }),
          setProfileState: () => authority.setProfileState(msg.sid, msg.state, msg.message),
        };
        const op = ops[msg?.op];
        if (!op) { reply({ id: msg?.id, ok: false, error: { code: 'bad_op', message: `Unknown op ${msg?.op}` } }); return; }
        op().then(
          (value) => reply({ id: msg.id, ok: true, value }),
          (err) => reply({ id: msg.id, ok: false, error: { code: err.code, status: err.status, message: err.message, name: err.name } }),
        );
      });
    });
  }

  self.MeetMemoSessionAuthority = { MSG, createSessionAuthority, installMessageHandler };
})();

// AUTH-02 / AUTH-03 / AUTH-04: shared session identity and lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowser, runClassic, loadProvider, settle, deferred, json, read } from './harness.mjs';

// Fake /v1/auth backend. refreshGate lets a test hold refresh responses.
function authBackend() {
  const state = { refreshGate: null, refreshCalls: 0, refreshMode: 'ok', tokens: 0 };
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    if (url.endsWith('/v1/auth/login') || url.endsWith('/v1/auth/signup')) {
      const uid = body.email.split('@')[0].toUpperCase();
      return json(200, { uid, email: body.email, displayName: null, idToken: `id-${uid}-${++state.tokens}`, refreshToken: `r-${uid}`, expiresIn: 3600 });
    }
    if (url.endsWith('/v1/auth/refresh')) {
      state.refreshCalls += 1;
      const gate = state.refreshGate;
      if (gate) await gate.promise;
      if (state.refreshMode === 'reject') return json(401, { error: 'invalid_credentials' });
      if (state.refreshMode === 'down') throw new TypeError('fetch failed');
      const uid = body.refreshToken.slice(2);
      return json(200, { uid, idToken: `refreshed-${uid}-${++state.tokens}`, refreshToken: body.refreshToken, expiresIn: 3600 });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { state, fetchImpl };
}

function setup() {
  const browser = createBrowser();
  const backend = authBackend();
  const worker = runClassic(
    ['meetmemo.config.js', 'extension-auth/session.js', 'extension-auth/sessionAuthority.js', 'sync/segment-id.js', 'sync/worker.js'],
    { chrome: browser.chromeFor({ url: 'chrome-extension://ext/service-worker.js' }), fetch: backend.fetchImpl },
  );
  const page = () => loadProvider(browser.chromeFor({ url: 'chrome-extension://ext/auth.html' }), backend.fetchImpl);
  return { browser, backend, worker, authority: worker.MeetMemoSync.authority, page };
}

const watch = (provider) => { const seen = []; provider.onAuthStateChanged((u) => seen.push(u ? u.uid : null)); return seen; };
const expire = async (browser) => {
  const s = browser.local.data.get('meetmemo_session');
  await browser.local.set({ meetmemo_session: { ...s, expiresAt: 0 } });
};

test('two live providers see login and logout made in either one', async () => {
  const { page } = setup();
  const a = page(); const b = page();
  const seenA = watch(a); const seenB = watch(b);
  await settle();
  await a.signIn({ email: 'a@x.test', password: 'p' });
  await settle();
  await b.signOut();
  await settle();
  assert.deepEqual(seenA, [null, 'A', null]);
  assert.deepEqual(seenB, [null, 'A', null]);
});

test('unsubscribe stops callbacks', async () => {
  const { page } = setup();
  const a = page(); const b = page();
  const seen = [];
  const off = b.onAuthStateChanged((u) => seen.push(u?.uid ?? null));
  await settle();
  off();
  await a.signIn({ email: 'a@x.test', password: 'p' });
  await settle();
  assert.deepEqual(seen, [null]);
});

test('worker-initiated removal (rejected refresh) reaches open pages', async () => {
  const { page, backend, browser, authority } = setup();
  const a = page(); const seen = watch(a);
  await a.signIn({ email: 'a@x.test', password: 'p' });
  await settle();
  await expire(browser);
  backend.state.refreshMode = 'reject';
  assert.equal(await authority.getAuth(), null);
  await settle();
  assert.equal(browser.local.data.has('meetmemo_session'), false);
  assert.deepEqual(seen, [null, 'A', null]);
});

test('a late initial read cannot overwrite a newer change', async () => {
  const browser = createBrowser();
  const chromeApi = browser.chromeFor();
  const slow = deferred();
  const realGet = chromeApi.storage.local.get;
  chromeApi.storage.local.get = async (k) => { const r = await realGet(k); await slow.promise; return r; }; // initial read held
  const ctx = runClassic(['extension-auth/session.js'], { chrome: chromeApi });
  const seen = [];
  ctx.MeetMemoSession.subscribe((u) => seen.push(u?.uid ?? null), chromeApi);
  await settle();
  // Session for A appears while the initial (empty) read is still pending.
  await browser.local.set({ meetmemo_session: { uid: 'A', sid: 's1', idToken: 't', refreshToken: 'r', expiresAt: Date.now() + 1e6 } });
  await settle();
  slow.resolve();
  await settle();
  assert.deepEqual(seen, ['A']);
});

test('held refresh followed by logout does not restore the session', async () => {
  const { page, backend, browser } = setup();
  const a = page();
  await a.signIn({ email: 'a@x.test', password: 'p' });
  await expire(browser);
  backend.state.refreshGate = deferred();
  const pending = a.getIdToken();
  await settle();
  await a.signOut();
  backend.state.refreshGate.resolve();
  assert.equal(await pending, null);
  await settle();
  assert.equal(browser.local.data.has('meetmemo_session'), false);
});

test('held refresh for A cannot replace account B', async () => {
  const { page, backend, browser } = setup();
  const p = page();
  await p.signIn({ email: 'a@x.test', password: 'p' });
  await expire(browser);
  backend.state.refreshGate = deferred();
  const pending = p.getIdToken();
  await settle();
  await p.signIn({ email: 'b@x.test', password: 'p' });
  backend.state.refreshGate.resolve();
  assert.equal(await pending, null);
  await settle();
  const s = browser.local.data.get('meetmemo_session');
  assert.equal(s.uid, 'B');
  assert.match(s.idToken, /^id-B-/);
});

test('concurrent refreshes for one session share a single request', async () => {
  const { page, backend, browser } = setup();
  const a = page(); const b = page();
  await a.signIn({ email: 'a@x.test', password: 'p' });
  await expire(browser);
  const tokens = await Promise.all([a.getIdToken(), b.getIdToken(), a.getIdToken()]);
  assert.equal(backend.state.refreshCalls, 1);
  assert.equal(new Set(tokens).size, 1);
  assert.match(tokens[0], /^refreshed-A-/);
});

test('transient refresh failure keeps the session; a later refresh succeeds', async () => {
  const { page, backend, browser } = setup();
  const a = page();
  await a.signIn({ email: 'a@x.test', password: 'p' });
  await expire(browser);
  backend.state.refreshMode = 'down';
  await assert.rejects(a.getIdToken());
  assert.equal(browser.local.data.get('meetmemo_session').uid, 'A');
  backend.state.refreshMode = 'ok';
  assert.match(await a.getIdToken(), /^refreshed-A-/);
});

test('profile setup failure after successful login is recorded on the session, scoped to it', async () => {
  const { page } = setup();
  const a = page();
  const seen = [];
  a.onAuthStateChanged((u) => seen.push(u && `${u.uid}:${u.profile.state}`));
  const user = await a.signIn({ email: 'a@x.test', password: 'p' });
  assert.equal(user.profile.state, 'pending');
  await a.setProfileState(user.sid, 'error', 'The backend hit an error.');
  await settle();
  assert.equal(seen.at(-1), 'A:error');
  assert.equal((await a.getUser()).profile.message, 'The backend hit an error.');
  // A result for an older session never lands on the current one.
  const b = await a.signIn({ email: 'b@x.test', password: 'p' });
  assert.equal(await a.setProfileState(user.sid, 'ready'), null);
  assert.equal((await a.getUser()).profile.state, 'pending');
  await a.setProfileState(b.sid, 'ready');
  assert.equal((await a.getUser()).profile.state, 'ready');
});

test('popup shows profile errors in the signed-in view, not the hidden sign-in form', () => {
  const src = read('auth.js');
  const submit = src.slice(src.indexOf('async function onSubmit'), src.indexOf('function showFormError'));
  assert.doesNotMatch(submit, /registerUser/, 'registration is not part of the sign-in form flow');
  assert.match(src, /profile-warning/);
  assert.match(read('auth.html'), /id="profile-retry"/);
});

test('content scripts cannot obtain tokens from the authority', async () => {
  const { browser } = setup();
  const tabChrome = browser.chromeFor({ url: 'https://meet.google.com/abc-defg-hij', tab: { id: 1, index: 0 } });
  const port = tabChrome.runtime.connect({ name: 'meetmemo-auth' });
  const reply = deferred();
  port.onMessage.addListener(reply.resolve);
  port.postMessage({ id: 1, op: 'getAuth' });
  const r = await reply.promise;
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'forbidden');
});

test('legacy sessions without a session id keep a stable identity', async () => {
  const browser = createBrowser();
  await browser.local.set({ meetmemo_session: { uid: 'A', idToken: 't', refreshToken: 'r', expiresAt: Date.now() + 1e6 } });
  const ctx = runClassic(['extension-auth/session.js'], { chrome: browser.chromeFor() });
  const u = await ctx.MeetMemoSession.currentUser(browser.chromeFor());
  assert.equal(u.sid, 'legacy-A');
  assert.equal(u.idToken, undefined, 'identity never exposes tokens');
});

test('GOOGLE-01: Google sign-in runs in the worker and commits the Firebase session returned by the backend', async () => {
  const browser = createBrowser(); let launched = null;
  const nonceOf = (u) => new URL(u).searchParams.get('nonce');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/v1/auth/config')) return json(200, { password: true, google: true, googleClientId: 'cid.apps.googleusercontent.com' });
    if (url.endsWith('/v1/auth/google')) {
      assert.match(JSON.parse(opts.body).idToken, /^h\./);
      return json(200, { uid: 'G1', email: 'g@x.test', displayName: 'G', idToken: 'fid', refreshToken: 'frt', expiresIn: 3600 });
    }
    throw new Error(`unexpected ${url}`);
  };
  const chrome = browser.chromeFor({ url: 'chrome-extension://ext/service-worker.js' });
  chrome.identity = {
    getRedirectURL: () => 'https://ext.chromiumapp.org/',
    launchWebAuthFlow: async ({ url }) => {
      launched = new URL(url);
      return `https://ext.chromiumapp.org/#id_token=${`h.${b64({ nonce: nonceOf(url) })}.s`}`;
    },
  };
  const worker = runClassic(['meetmemo.config.js', 'extension-auth/session.js', 'extension-auth/sessionAuthority.js', 'sync/segment-id.js', 'sync/worker.js'], { chrome, fetch: fetchImpl, atob: globalThis.atob });
  const user = await worker.MeetMemoSync.authority.googleSignIn();
  assert.equal(user.uid, 'G1');
  assert.equal(launched.searchParams.get('client_id'), 'cid.apps.googleusercontent.com');
  assert.equal(launched.searchParams.get('response_type'), 'id_token');
  assert.equal(launched.searchParams.get('redirect_uri'), 'https://ext.chromiumapp.org/');
  assert.equal((await worker.MeetMemoSync.authority.getAuth()).idToken, 'fid');
});

test('GOOGLE-02: a token whose nonce does not match is refused and no session is stored', async () => {
  const browser = createBrowser();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const fetchImpl = async (url) => {
    if (url.endsWith('/v1/auth/config')) return json(200, { google: true, googleClientId: 'cid' });
    throw new Error('backend must not be called');
  };
  const chrome = browser.chromeFor({ url: 'chrome-extension://ext/service-worker.js' });
  chrome.identity = { getRedirectURL: () => 'https://ext.chromiumapp.org/', launchWebAuthFlow: async () => `https://ext.chromiumapp.org/#id_token=h.${b64({ nonce: 'other' })}.s` };
  const worker = runClassic(['meetmemo.config.js', 'extension-auth/session.js', 'extension-auth/sessionAuthority.js', 'sync/segment-id.js', 'sync/worker.js'], { chrome, fetch: fetchImpl, atob: globalThis.atob });
  await assert.rejects(worker.MeetMemoSync.authority.googleSignIn(), { code: 'google_failed' });
  assert.equal(await worker.MeetMemoSync.authority.getUser(), null);
});

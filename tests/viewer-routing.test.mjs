// VIEW-01 / VIEW-02 / SHARE-01 (viewer + client pagination) and ROUTE-01 (link routing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowser, runClassic, runModulePage, loadApiClient, settle, deferred, json, read } from './harness.mjs';

// ---------------------------------------------------------------- tiny DOM

function fakeDom(ids) {
  const make = (tag) => {
    const el = {
      tag, hidden: false, className: '', children: [], listeners: {}, _text: '', disabled: false,
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set textContent(v) { this._text = String(v); this.children = []; },
      append(...c) { this.children.push(...c.map((x) => (typeof x === 'string' ? { textContent: x } : x))); },
      replaceChildren(...c) { this._text = ''; this.children = []; this.append(...c.flatMap((x) => (x?.isFragment ? x.children : [x]))); },
      addEventListener(n, f) { this.listeners[n] = f; },
      setAttribute() {},
    };
    return el;
  };
  const els = Object.fromEntries(ids.map((id) => [id, make('div')]));
  const document = {
    title: '',
    getElementById: (id) => els[id],
    createElement: make,
    createDocumentFragment: () => Object.assign(make('#fragment'), { isFragment: true }),
    addEventListener() {},
  };
  return { els, document };
}

// ---------------------------------------------------------------- fake backend for the viewer

function viewerBackend() {
  const st = { segments: [], owner: 'A', holdGet: null, pagesServed: 0, authSeen: [] };
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const uid = opts.headers.Authorization.replace('Bearer tok-', '');
    st.authSeen.push(uid);
    if (st.holdGet) await st.holdGet.promise;
    if (uid !== st.owner) return json(404, { error: 'not_found' }); // ownership enforced on every call
    if (u.pathname === '/v1/meetings/m1') return json(200, { id: 'm1', title: 'Standup', ownerId: st.owner });
    if (u.pathname === '/v1/meetings/m1/segments') {
      st.pagesServed += 1;
      const limit = Number(u.searchParams.get('limit'));
      const start = Number(u.searchParams.get('after') || 0);
      const items = st.segments.slice(start, start + limit);
      return json(200, { items, next: start + limit < st.segments.length ? String(start + limit) : null });
    }
    throw new Error(`unexpected ${u.pathname}`);
  };
  return { st, fetchImpl };
}

// Provider stub driven by the shared storage, like the real one.
function providerFor(browser, chromeApi) {
  const S = runClassic(['extension-auth/session.js'], { chrome: chromeApi }).MeetMemoSession;
  return {
    S,
    provider: {
      onAuthStateChanged: (cb) => S.subscribe(cb, chromeApi),
      async getAuth() {
        const s = browser.local.data.get('meetmemo_session');
        return s ? { idToken: `tok-${s.uid}`, user: S.toUser(s) } : null;
      },
    },
  };
}

const sessionFor = (uid, sid) => ({ uid, sid, email: `${uid}@x.test`, idToken: `tok-${uid}`, refreshToken: 'r', expiresAt: Date.now() + 1e6 });

function openViewer(browser, backend, query = '?id=m1') {
  const chromeApi = browser.chromeFor({ url: 'chrome-extension://ext/transcript.html' });
  const { provider, S } = providerFor(browser, chromeApi);
  const createApiClient = loadApiClient();
  const { els, document } = fakeDom(['title', 'meta', 'copy', 'error', 'notice', 'segments', 'platform', 'download', 'print', 'translate-box', 'translate-to', 'translate-status']);
  const copied = [];
  // Ask AI panel stub: records what transcript.js tells it (its own behaviour is tested separately).
  const panelCalls = [];
  const createAskPanel = () => ({
    setUser: (u) => panelCalls.push(['setUser', u ? u.uid : null]),
    transcriptReady: (items) => panelCalls.push(['transcriptReady', items.length]),
  });
  const ctx = runModulePage('transcript.js', {
    chrome: chromeApi,
    MeetMemoSession: S,
    MeetMemoFormat: runClassic(['ui/format.js'], { chrome: chromeApi }).MeetMemoFormat,
    document,
    location: { search: query },
    navigator: { clipboard: { writeText: async (t) => copied.push(t) } },
  }, {
    createAuthProvider: () => provider,
    createClient: (p) => createApiClient({ baseUrl: 'http://api.test', authProvider: p, fetchImpl: backend.fetchImpl }),
    createAskPanel,
    // The live view uses the MeetMemo AI panel instead; same stub contract.
    createLivePanel: () => ({
      setUser: (u) => panelCalls.push(['setUser', u ? u.uid : null]),
      transcriptReady: (items) => panelCalls.push(['transcriptReady', items.length]),
    }),
  });
  const text = () => els.segments.textContent;
  return { els, ctx, copied, text, panelCalls, rows: () => els.segments.children.length };
}

const seg = (i, ts = 1000) => ({ id: `s${i}`, ts, text: `line ${i}`, speaker: 'Ada' });

// ---------------------------------------------------------------- VIEW-01

test('VIEW-01: 1,001+ segments are all shown, counted and copied', async () => {
  const browser = createBrowser(); const backend = viewerBackend();
  backend.st.segments = Array.from({ length: 2345 }, (_, i) => seg(i, 1000 + Math.floor(i / 10)));
  await browser.local.set({ meetmemo_session: sessionFor('A', 's1') });
  const v = openViewer(browser, backend);
  await settle(80);
  assert.equal(v.ctx.__error, undefined);
  assert.equal(v.rows(), 2345);
  assert.match(v.els.meta.textContent, /2345 lines/);
  assert.doesNotMatch(v.els.meta.textContent, /incomplete/);
  assert.equal(backend.st.pagesServed, 3);
  assert.ok(backend.st.authSeen.every((u) => u === 'A'));
  v.els.copy.hidden || await v.els.copy.listeners.click();
  assert.equal(v.copied[0].split('\n').length, 2345);
  assert.match(v.els.meta.textContent, /Private/);
});

test('VIEW-01: apiClient.listAllSegments follows cursors until next is null', async () => {
  const createApiClient = loadApiClient();
  const pages = { '': { items: [1, 2], next: 'c1' }, c1: { items: [3], next: 'c2' }, c2: { items: [], next: null } };
  const seen = [];
  const api = createApiClient({
    baseUrl: 'http://api.test',
    authProvider: { getAuth: async () => ({ idToken: 't', user: { uid: 'A' } }) },
    fetchImpl: async (url) => { const after = new URL(url).searchParams.get('after') || ''; seen.push(after); return json(200, pages[after]); },
  });
  const r = await api.listAllSegments('m1');
  assert.deepEqual([...r.items], [1, 2, 3]);
  assert.equal(r.complete, true);
  assert.deepEqual(seen, ['', 'c1', 'c2']);
  await assert.rejects(api.listAllSegments('m1', { expectUid: 'B' }), /account changed/);
});

// ---------------------------------------------------------------- VIEW-02

test('VIEW-02: logout while a transcript GET is held discards the late result', async () => {
  const browser = createBrowser(); const backend = viewerBackend();
  backend.st.segments = [seg(1)];
  await browser.local.set({ meetmemo_session: sessionFor('A', 's1') });
  backend.st.holdGet = deferred();
  const v = openViewer(browser, backend);
  await settle(20);
  await browser.local.remove('meetmemo_session');
  await settle(20);
  backend.st.holdGet.resolve();
  await settle(60);
  assert.equal(v.rows(), 0);
  assert.equal(v.els.copy.hidden, true);
  assert.match(v.els.error.textContent, /Signed out/);
});

test('VIEW-02: logout after rendering clears the text and the copy buffer', async () => {
  const browser = createBrowser(); const backend = viewerBackend();
  backend.st.segments = [seg(1), seg(2)];
  await browser.local.set({ meetmemo_session: sessionFor('A', 's1') });
  const v = openViewer(browser, backend);
  await settle(60);
  assert.equal(v.rows(), 2);
  await browser.local.remove('meetmemo_session');
  await settle(30);
  assert.equal(v.rows(), 0);
  assert.equal(v.els.copy.hidden, true);
  await v.els.copy.listeners.click();
  assert.deepEqual(v.copied, [], 'nothing left to copy');
});

test('VIEW-02: switching to account B re-authorizes; B never sees A\'s transcript', async () => {
  const browser = createBrowser(); const backend = viewerBackend();
  backend.st.segments = [seg(1)];
  await browser.local.set({ meetmemo_session: sessionFor('A', 's1') });
  const v = openViewer(browser, backend);
  await settle(60);
  assert.equal(v.rows(), 1);
  await browser.local.set({ meetmemo_session: sessionFor('B', 's2') });
  await settle(60);
  assert.equal(v.rows(), 0);
  assert.match(v.els.error.textContent, /not found/i);
  assert.equal(backend.st.authSeen.at(-1), 'B');
});

test('VIEW-AI-01: the Ask AI panel follows the signed-in account and the rendered transcript', async () => {
  const browser = createBrowser(); const backend = viewerBackend();
  backend.st.segments = [seg(1), seg(2)];
  await browser.local.set({ meetmemo_session: sessionFor('A', 's1') });
  const v = openViewer(browser, backend);
  await settle(60);
  assert.deepEqual(v.panelCalls.filter(([k]) => k === 'setUser'), [['setUser', 'A']]);
  assert.deepEqual(v.panelCalls.at(-1), ['transcriptReady', 2]);
  await browser.local.remove('meetmemo_session');
  await settle(60);
  assert.deepEqual(v.panelCalls.filter(([k]) => k === 'setUser').at(-1), ['setUser', null], 'sign-out clears the panel');
  await browser.local.set({ meetmemo_session: sessionFor('B', 's2') });
  await settle(60);
  assert.deepEqual(v.panelCalls.filter(([k]) => k === 'setUser').at(-1), ['setUser', 'B']);
  assert.notDeepEqual(v.panelCalls.at(-1), ['transcriptReady', 2], "B never gets A's transcript in the panel");
});

// ---------------------------------------------------------------- SHARE-01

test('SHARE-01: viewer opened before a held save refreshes when the save lands', async () => {
  const browser = createBrowser(); const backend = viewerBackend();
  await browser.local.set({ meetmemo_session: sessionFor('A', 's1') });
  const v = openViewer(browser, backend, '?id=m1&live=1');
  await settle(60);
  assert.equal(v.rows(), 0);
  assert.match(v.text(), /No lines saved yet/);
  const statusBase = { uid: 'A', sid: 's1' };
  await browser.local.set({ meetmemo_sync_status: { ...statusBase, meetings: { t: { meetingId: 'm1', state: 'saving', queued: 2, at: 1 } } } });
  await settle(20);
  assert.match(v.els.notice.textContent, /2 lines still on the way/);
  // First batch saved, then the second; the viewer follows both.
  backend.st.segments = [seg(1)];
  await browser.local.set({ meetmemo_sync_status: { ...statusBase, meetings: { t: { meetingId: 'm1', state: 'saving', queued: 1, savedAt: 10, at: 2 } } } });
  await new Promise((r) => setTimeout(r, 400)); await settle(40);
  assert.equal(v.rows(), 1);
  backend.st.segments = [seg(1), seg(2)];
  await browser.local.set({ meetmemo_sync_status: { ...statusBase, meetings: { t: { meetingId: 'm1', state: 'saved', queued: 0, savedAt: 20, at: 3 } } } });
  await new Promise((r) => setTimeout(r, 400)); await settle(40);
  assert.equal(v.rows(), 2);
  assert.equal(v.els.notice.hidden, true);
});

test('SHARE-01: a failed save is shown, not hidden; status for another account is ignored', async () => {
  const browser = createBrowser(); const backend = viewerBackend();
  await browser.local.set({ meetmemo_session: sessionFor('A', 's1') });
  const v = openViewer(browser, backend, '?id=m1&live=1');
  await settle(60);
  await browser.local.set({ meetmemo_sync_status: { uid: 'B', sid: 'x', meetings: { t: { meetingId: 'm1', state: 'error', message: 'B failed', at: 1 } } } });
  await settle(20);
  assert.equal(v.els.notice.hidden, true);
  await browser.local.set({ meetmemo_sync_status: { uid: 'A', sid: 's1', meetings: { t: { meetingId: 'm1', state: 'error', message: 'HTTP 500', queued: 3, at: 2 } } } });
  await settle(20);
  assert.match(v.els.notice.textContent, /not saved yet: HTTP 500/);
});

test('SHARE-01: Share waits for durable receipt of pending lines before opening', async () => {
  const browser = createBrowser();
  const opened = [];
  const order = [];
  browser.messageListeners.add((m) => { if (m.type === 'meetmemo-open') opened.push(m); order.push('open'); });
  // Worker side of the sync port: hold the receipt.
  const receipt = deferred();
  browser.connectListeners.add((port) => {
    port.onMessage.addListener(async (m) => { await receipt.promise; order.push('received'); port.postMessage({ type: 'received', id: m.id, ok: true }); });
  });
  const handlers = {};
  const ss = new Map();
  const ctx = runClassic(['extension-auth/session.js', 'extension-auth/localBridge.js', 'extension-auth/links.js', 'sync/content.js'], {
    chrome: browser.chromeFor({ url: 'https://meet.google.com/abc-defg-hij', tab: { id: 1, index: 0 } }),
    location: { pathname: '/abc-defg-hij' },
    sessionStorage: { getItem: (k) => ss.get(k) ?? null, setItem: (k, v) => ss.set(k, v) },
    document: { documentElement: { addEventListener: (n, f) => { handlers[n] = f; } } },
    addEventListener: (n, f) => { handlers[n] = f; },
    setInterval: () => 1,
    clearInterval() {},
  });
  handlers['MeetMemo-message']({ detail: { type: 'speech', messages: [{ messageId: '1', text: 'hi', messageVersion: 1 }] } });
  ctx.MEETMEMO_LINKS.signIn('share-button');
  await settle(20);
  assert.equal(opened.length, 0, 'not opened before receipt');
  receipt.resolve();
  await settle(40);
  assert.deepEqual(order, ['received', 'open']);
  assert.equal(opened[0].target, 'transcript');
  assert.equal(opened[0].meeting.meetingCode, 'abc-defg-hij');
});

// ---------------------------------------------------------------- ROUTE-01

test('ROUTE-01: every inventoried destination maps explicitly', async () => {
  const browser = createBrowser();
  const sent = [];
  browser.messageListeners.add((m) => sent.push(m));
  const ctx = runClassic(['extension-auth/links.js'], { chrome: browser.chromeFor() });
  const { appUrl, signIn } = ctx.MEETMEMO_LINKS;
  const base = 'chrome-extension://ext/';
  const cases = {
    '/auth?i=x': 'auth.html', '/transcripts': 'history.html', '': 'auth.html', '/': 'auth.html', '/welcome': 'auth.html',
    '/transcripts/hosted123': 'unavailable.html?feature=hosted-transcript',
    '/settings': 'settings.html', '/settings/tags': 'settings.html', '/settings/general': 'settings.html',
    '/help': 'help.html', '/privacy': 'privacy.html',
    '/billing': 'unavailable.html?feature=billing', '/invite': 'unavailable.html?feature=invite',
    '/something-new': 'unavailable.html?feature=hosted',
  };
  for (const [p, dest] of Object.entries(cases)) assert.equal(appUrl(p), base + dest, p);
  for (const s of ['widget-header', 'transcript-notification', 'must-relogin-popover', 'sign-up-popover', 'options-page']) signIn(s);
  signIn('screenshot-button'); signIn('minimised-screenshot-button'); signIn('unsaved-transcript');
  signIn('share-button'); // no sync layer on this page -> sign-in
  await settle(10);
  assert.deepEqual(sent.map((m) => m.target + (m.feature ? `:${m.feature}` : '')), [
    'signin', 'signin', 'signin', 'signin', 'signin',
    'unavailable:screenshots', 'unavailable:screenshots', 'unavailable:unsaved-transcripts', 'signin',
  ]);
});

test('ROUTE-01: worker opens the right page for each panel action', async () => {
  const browser = createBrowser();
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/v1/meetings') && opts.method === 'POST') return json(201, { id: 'meet-1' });
    throw new TypeError('offline');
  };
  const worker = runClassic(['meetmemo.config.js', 'extension-auth/session.js', 'extension-auth/sessionAuthority.js', 'sync/segment-id.js', 'sync/worker.js'],
    { chrome: browser.chromeFor({ url: 'chrome-extension://ext/service-worker.js' }), fetch: fetchImpl });
  const tab = browser.chromeFor({ url: 'https://meet.google.com/abc-defg-hij', tab: { id: 3, index: 4, windowId: 9 } });
  const meeting = { sessionId: 'tab-1', platform: 'googlemeet', meetingCode: 'abc-defg-hij', title: 't' };
  await tab.runtime.sendMessage({ type: 'meetmemo-open', target: 'transcript', meeting });
  await settle(30);
  assert.deepEqual(browser.opened.at(-1), { kind: 'window', url: 'chrome-extension://ext/auth.html', type: 'popup', width: 380, height: 640 }, 'signed out -> sign in');
  await worker.MeetMemoSync.authority.commitLogin({ uid: 'A', idToken: 'tok-A', refreshToken: 'r', expiresIn: 3600 });
  await tab.runtime.sendMessage({ type: 'meetmemo-open', target: 'transcript', meeting });
  await settle(40);
  assert.deepEqual(browser.opened.at(-1), { kind: 'tab', url: 'chrome-extension://ext/transcript.html?id=meet-1&live=1', index: 5, windowId: 9 });
  await tab.runtime.sendMessage({ type: 'meetmemo-open', target: 'transcript', meeting, ask: true });
  await settle(40);
  assert.equal(browser.opened.at(-1).url, 'chrome-extension://ext/transcript.html?id=meet-1&live=1&ask=1', 'Ask AI opens the panel');
  await tab.runtime.sendMessage({ type: 'meetmemo-open', target: 'unavailable', feature: 'billing' });
  await settle(20);
  assert.equal(browser.opened.at(-1).url, 'chrome-extension://ext/unavailable.html?feature=billing');
  for (const page of ['history', 'settings', 'help', 'privacy']) {
    await tab.runtime.sendMessage({ type: 'meetmemo-open', target: 'page', page });
    await settle(20);
    assert.deepEqual(browser.opened.at(-1), { kind: 'tab', url: `chrome-extension://ext/${page}.html`, index: 5, windowId: 9 });
  }
  const before = browser.opened.length;
  await tab.runtime.sendMessage({ type: 'meetmemo-open', target: 'page', page: '../evil' });
  await settle(20);
  assert.equal(browser.opened.length, before, 'unknown pages are ignored');
});

test('ROUTE-01: bundle bridge anchors are present exactly once', () => {
  const content = read('content.js');
  const options = read('options.js');
  const once = (src, s) => assert.equal(src.split(s).length - 1, 1, s.slice(0, 60));
  once(content, 'function Za(e){if(self.MEETMEMO_LINKS)return self.MEETMEMO_LINKS.signIn(e);');
  once(content, 'function gn(e){return self.MEETMEMO_LINKS?self.MEETMEMO_LINKS.appUrl(e):');
  once(content, 'Fl=(self.MEETMEMO_PANEL={currentTranscript:()=>Fl()},');
  once(content, 'showLoginButton:self.MEETMEMO_LOCAL_AUTH?self.MEETMEMO_LOCAL_AUTH.showSignIn(mc.default,!e?.id):!e?.id');
  once(content, 'o=self.MEETMEMO_LOCAL_AUTH?self.MEETMEMO_LOCAL_AUTH.showSignIn(Le.default,W(rm)):W(rm)');
  once(content, 'statusMessage:self.MEETMEMO_LOCAL_AUTH?.isSignedIn()?');
  once(options, 'function Vw(e){if(self.MEETMEMO_LINKS)return self.MEETMEMO_LINKS.signIn(e);');
  once(options, 'function aa(e){return self.MEETMEMO_LINKS?self.MEETMEMO_LINKS.appUrl(e):');
  once(options, 'mmLocal=self.MEETMEMO_LOCAL_AUTH?self.MEETMEMO_LOCAL_AUTH.useUser(on.default):null');
  once(options, 'mmLocal=self.MEETMEMO_LOCAL_AUTH?self.MEETMEMO_LOCAL_AUTH.useUser(Wt.default):null');
  // Hosted "Signed out" / "Sign Up" popovers are gated on the local account.
  once(content, 'u?.mustRelogin?Ln.default.createElement(self.MEETMEMO_LOCAL_AUTH?self.MEETMEMO_LOCAL_AUTH.hostedPrompt(Ln.default):Ln.default.Fragment,null,Ln.default.createElement(X7,null)):null');
  once(content, 'u?.mustSignUp?Ln.default.createElement(self.MEETMEMO_LOCAL_AUTH?self.MEETMEMO_LOCAL_AUTH.hostedPrompt(Ln.default):Ln.default.Fragment,null,Ln.default.createElement(NY,null)):null');
  assert.equal(content.split('createElement(X7,null)').length - 1, 1, 'X7 mounted only behind the gate');
  assert.equal(content.split('createElement(NY,null)').length - 1, 1, 'NY mounted only behind the gate');
  assert.equal(content.split('self.MEETMEMO_LINKS.signIn("ask-ai"):n($L());return}').length - 1, 2);
  assert.equal(content.split('n($L());return}').length - 1, 2, 'no ungated Ask AI relogin trigger');
  // No unrouted navigation to the hosted MeetMemo domains.
  once(content, 'var YP=self.MEETMEMO_LINKS?self.MEETMEMO_LINKS.appUrl("/help"):');
  for (const [name, src] of [['content.js', content], ['options.js', options]]) {
    const opens = src.match(/window\.open\("https:\/\/[^"]*meetmemo\.io[^"]*"/gi) || [];
    const routed = src.match(/self\.MEETMEMO_LINKS\.openHelp\(\):window\.open\("https:\/\/[^"]*meetmemo\.io[^"]*"/gi) || [];
    assert.equal(opens.length, routed.length, `${name}: every hosted window.open is routed`);
  }
  const background = read('background.js');
  assert.equal(background.split('/api/2/u/welcome/').length - 1, 0, 'no install redirect to api2.MeetMemo.io');
  once(background, 'chrome.runtime.setUninstallURL(""),');
  once(background, 'await chrome.tabs.create({url:chrome.runtime.getURL("auth.html")})');
  const manifest = JSON.parse(read('manifest.json'));
  const sync = manifest.content_scripts.find((c) => c.js.includes('sync/content.js'));
  assert.deepEqual(sync.js, ['extension-auth/session.js', 'extension-auth/localBridge.js', 'extension-auth/links.js', 'extension-auth/panelPrivacy.js', 'sync/live-detect.js', 'sync/content.js', 'sync/claude-dock.js']);
  // The Claude tab, its switch and the answer feed live in the panel's tab bar (sync/claude-dock.js).
  once(content, 'vi.default.createElement("span",{"data-meetmemo-claude-toggle":"",className:"flex shrink-0 items-center"})');
  once(content, 'vi.default.createElement("div",{"data-meetmemo-claude-feed":""})');
  assert.equal(content.split('defaultMessage:"Claude"').length - 1, 3, 'tab, minimised button and its tooltip say Claude');
  assert.equal(content.split('MeetMemo AI').length - 1, 0, 'no outdated assistant name left in the panel');
  // Privacy popover and "Notify in chat" no longer point at the old hosted domain.
  once(content, 'self.MEETMEMO_PANEL_PRIVACY?self.MEETMEMO_PANEL_PRIVACY.items(ye.default):');
  assert.equal(content.split('MeetMemo.io/r/notetaking').length - 1, 0);
  const war = manifest.web_accessible_resources.find((w) => w.resources.includes('auth.html'));
  for (const p of ['history.html', 'settings.html', 'help.html', 'privacy.html']) assert.ok(war.resources.includes(p), p);
  assert.match(read('options.html'), /extension-auth\/links\.js"><\/script>\s*<script src="\/options\.js">/);
  // Only the Render API is a host permission; hosted MeetMemo hosts are blocked, never allowed.
  const apiHosts = manifest.host_permissions.filter((h) => !h.includes('meet.google.com'));
  assert.deepEqual(apiHosts, ['https://meetmemo-api.onrender.com/*']);
  assert.ok(!JSON.stringify(manifest.externally_connectable).toLowerCase().includes('meetmemo.io'));
  const ruleset = manifest.declarative_net_request.rule_resources.find((r) => r.id === 'block_hosted_meetmemo');
  assert.ok(ruleset?.enabled);
  const rules = JSON.parse(read(ruleset.path));
  assert.equal(rules[0].action.type, 'block');
  assert.equal(rules[0].condition.urlFilter, '||meetmemo.io^');
  assert.ok(rules[0].condition.resourceTypes.includes('main_frame'));
  // Leftover analytics in the bundles (Mixpanel, Datadog) are blocked for the extension and the
  // meeting pages only, never for the rest of the user's browsing.
  const analytics = rules.find((r) => r.id === 2);
  assert.equal(analytics.action.type, 'block');
  assert.deepEqual(analytics.condition.requestDomains, ['mixpanel.com', 'browser-intake-datadoghq.com']);
  assert.ok(analytics.condition.initiatorDomains.includes('gnolicpkknhchlmmfgamghnjcbmpndlf'));
  assert.ok(analytics.condition.initiatorDomains.includes('meet.google.com'));
});

test('PAGES-01: new pages reference files that exist and share one stylesheet', () => {
  for (const page of ['history.html', 'transcript.html', 'settings.html', 'help.html', 'privacy.html', 'unavailable.html']) {
    const html = read(page);
    assert.match(html, /href="ui\/pages\.css"/, page);
    for (const [, src] of html.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css|png|svg|html))"/g)) {
      assert.doesNotThrow(() => read(src), `${page} -> ${src}`);
    }
    assert.doesNotMatch(html, /meetmemo\.io/i, `${page} links to the old hosted domain`);
  }
});

test('FORMAT-01: meeting headings, durations and preferences', async () => {
  const browser = createBrowser();
  const F = runClassic(['ui/format.js'], { chrome: browser.chromeFor() }).MeetMemoFormat;
  const auto = F.meetingHeading({ platform: 'googlemeet', meetingCode: 'abc-defg-hij', title: 'Google Meet abc-defg-hij — 11/25/2026, 10:55:39 AM' });
  assert.deepEqual({ ...auto }, { platform: 'Google Meet', code: 'abc-defg-hij', title: 'abc-defg-hij', isCustom: false });
  const custom = F.meetingHeading({ platform: 'googlemeet', meetingCode: 'abc-defg-hij', title: 'Weekly sync' });
  assert.equal(custom.title, 'Weekly sync');
  assert.equal(custom.isCustom, true);
  assert.equal(F.meetingHeading({}).title, 'Untitled meeting');
  assert.equal(F.duration(30_000), 'under 1 min');
  assert.equal(F.duration(42 * 60_000), '42 min');
  assert.equal(F.duration(125 * 60_000), '2 h 5 min');
  assert.equal(F.initials('Ada Lovelace'), 'AL');
  assert.equal(F.speakerSlot('Ada'), F.speakerSlot('Ada'));
  assert.equal(F.toDate({ _seconds: 0 }).getTime(), 0);
  assert.equal(F.toDate('garbage'), null);
  assert.deepEqual({ ...(await F.getPrefs()) }, { readingLanguage: '', aiLanguage: '', aiPanelOpen: true });
  await F.setPrefs({ readingLanguage: 'hi' });
  assert.equal((await F.getPrefs()).readingLanguage, 'hi');
  assert.equal((await F.getPrefs()).aiLanguage, '');
});

test('PRIVACY-01: panel privacy popover renders accurate answers and links to privacy.html', async () => {
  const browser = createBrowser();
  const chromeApi = browser.chromeFor();
  const sent = [];
  chromeApi.runtime.sendMessage = async (m) => { sent.push(structuredClone(m)); };
  const ctx = runClassic(['extension-auth/links.js', 'extension-auth/panelPrivacy.js'], { chrome: chromeApi });
  const h = (type, props, ...children) => ({ type, props: props || {}, children });
  const React = { createElement: h, Fragment: 'Fragment' };
  const tree = ctx.MEETMEMO_PANEL_PRIVACY.items(React);
  assert.equal(tree.type, 'Fragment');
  const flat = (n) => (typeof n === 'string' ? n : (n.children || []).map(flat).join(' '));
  const text = flat(tree);
  assert.match(text, /never records audio or video/);
  assert.match(text, /Only you/);
  assert.doesNotMatch(text, /meetmemo\.io/i);
  assert.deepEqual(tree.children.map((c) => c.type), ['dd', 'dt', 'dd', 'dt', 'dd', 'dd']);
  const button = tree.children.at(-1).children[0];
  button.props.onClick();
  assert.deepEqual(sent, [{ type: 'meetmemo-open', target: 'page', page: 'privacy' }]);
});

test('ROUTE-02: help links and Ask AI (signed in locally) open local explanation pages', async () => {
  const browser = createBrowser();
  const chromeApi = browser.chromeFor();
  const sent = [];
  chromeApi.runtime.sendMessage = async (m) => { sent.push(structuredClone(m)); }; // clone out of the VM realm
  const L = runClassic(['extension-auth/links.js'], { chrome: chromeApi }).MEETMEMO_LINKS;
  assert.equal(L.appUrl('/help'), 'chrome-extension://ext/help.html');
  L.openHelp();
  L.signIn('ask-ai');
  L.signIn('must-relogin-popover');
  assert.deepEqual(sent, [
    { type: 'meetmemo-open', target: 'page', page: 'help' },
    { type: 'meetmemo-open', target: 'unavailable', feature: 'ai' },
    { type: 'meetmemo-open', target: 'signin' },
  ]);
  const unavailable = read('unavailable.js');
  assert.match(unavailable, /\n  ai: \[/);
  assert.match(unavailable, /\n  help: \[/);
});

test('AUTH-02: hosted Signed out / Sign Up popovers are hidden while a local account is signed in', async () => {
  const browser = createBrowser();
  const ctx = runClassic(['extension-auth/session.js', 'extension-auth/localBridge.js'], { chrome: browser.chromeFor() });
  const L = ctx.MEETMEMO_LOCAL_AUTH;
  const React = { useSyncExternalStore: (sub, get) => get() };
  const Gate = L.hostedPrompt(React);
  assert.equal(L.hostedPrompt(React), Gate, 'stable component identity across renders');
  const popover = { popover: 'Signed out' };
  await settle();
  assert.equal(Gate({ children: popover }), popover, 'signed out: prompt shown');
  await browser.local.set({ meetmemo_session: sessionFor('A', 's1') });
  await settle();
  assert.equal(Gate({ children: popover }), null, 'signed in (Render account): no sign-in prompt');
  await browser.local.remove('meetmemo_session');
  await settle();
  assert.equal(Gate({ children: popover }), popover, 'logout brings the prompt back');
});

test('AUTH-01: local bridge hook hides sign-in prompts only while a local account is signed in', async () => {
  const browser = createBrowser();
  const ctx = runClassic(['extension-auth/session.js', 'extension-auth/localBridge.js'], { chrome: browser.chromeFor() });
  const L = ctx.MEETMEMO_LOCAL_AUTH;
  // Minimal useSyncExternalStore stand-in: reads the snapshot synchronously.
  const React = { useSyncExternalStore: (sub, get) => get() };
  await settle();
  assert.equal(L.showSignIn(React, true), true);
  let notified = 0; L.subscribe(() => { notified += 1; });
  await browser.local.set({ meetmemo_session: sessionFor('A', 's1') });
  await settle();
  assert.equal(notified, 1);
  assert.equal(L.showSignIn(React, true), false, 'local account signed in');
  assert.equal(L.showSignIn(React, false), false);
  await browser.local.remove('meetmemo_session');
  await settle();
  assert.equal(L.showSignIn(React, true), true, 'logout restores the prompt without reload');
});

// PLATFORM-01..05: Zoom, Microsoft Teams and Upwork support alongside Google Meet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowser, runClassic, settle, read, json } from './harness.mjs';

const loadPlatforms = () => runClassic(['sync/platforms.js'], {}).MeetMemoPlatforms;
const loc = (url) => { const u = new URL(url); return { host: u.host, hostname: u.hostname, pathname: u.pathname }; };

// ---------------------------------------------------------------- fake backend + worker

function meetingsBackend() {
  const meetings = new Map();
  let n = 0;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    const uid = (opts.headers?.Authorization || '').replace('Bearer tok-', '');
    if (!uid) return json(401, { error: 'unauthenticated' });
    if (u.pathname === '/v1/meetings' && opts.method === 'POST') {
      const id = `meeting-${++n}`;
      meetings.set(id, { body, segments: new Map() });
      return json(201, { id });
    }
    const m = u.pathname.match(/^\/v1\/meetings\/([^/]+)\/segments$/);
    if (m && opts.method === 'POST') {
      const mt = meetings.get(decodeURIComponent(m[1]));
      for (const s of body.segments) mt.segments.set(s.messageId, s);
      return json(200, { written: body.segments.length, stale: 0 });
    }
    throw new Error(`unexpected ${opts.method} ${u.pathname}`);
  };
  return { meetings, fetchImpl, created: () => [...meetings.values()].map((m) => m.body), texts: () => [...meetings.values()].flatMap((m) => [...m.segments.values()].map((s) => s.text)).sort() };
}

const WORKER_FILES = ['meetmemo.config.js', 'extension-auth/session.js', 'extension-auth/sessionAuthority.js', 'sync/segment-id.js', 'sync/worker.js'];

async function signedInWorker(browser, backend) {
  const w = runClassic(WORKER_FILES, { chrome: browser.chromeFor({ url: 'chrome-extension://ext/service-worker.js' }), fetch: backend.fetchImpl });
  await w.MeetMemoSync.authority.commitLogin({ uid: 'A', email: 'a@x.test', idToken: 'tok-A', refreshToken: 'r-A', expiresIn: 3600 });
  return w;
}

// A meeting tab at `url` running the real content-side sync layer, in manifest order.
function meetingTab(browser, url, { sessionId = 'tab-1' } = {}) {
  const handlers = {};
  let interval;
  const ss = new Map();
  const ctx = runClassic(['extension-auth/session.js', 'extension-auth/localBridge.js', 'extension-auth/links.js', 'sync/live-detect.js', 'sync/platforms.js', 'sync/content.js'], {
    chrome: browser.chromeFor({ url, tab: { id: 7, index: 2, windowId: 1 } }),
    location: loc(url),
    sessionStorage: { getItem: (k) => ss.get(k) ?? null, setItem: (k, v) => ss.set(k, v) },
    crypto: { randomUUID: () => sessionId, subtle: globalThis.crypto.subtle },
    document: { documentElement: { addEventListener: (n, f) => { handlers[n] = f; } } },
    addEventListener: (n, f) => { handlers[n] = f; },
    setInterval: (f) => { interval = f; return 1; },
    clearInterval() {},
  });
  const emit = (detail) => handlers['MeetMemo-message']({ detail });
  return {
    ctx,
    emit,
    speak: (id, text) => emit({ type: 'speech', messages: [{ messageId: id, text, messageVersion: 1, deviceId: 'd1', deviceName: 'Client' }] }),
    flush: () => interval(),
  };
}

// ---------------------------------------------------------------- PLATFORM-01 identity

test('PLATFORM-01: each platform is recognised and identifies its meeting like the bundled panel', () => {
  const P = loadPlatforms();
  const at = (url, ...rest) => { const l = loc(url); const p = P.platformOf(l); return [p, P.meetingCode(p, l, ...rest)]; };
  assert.deepEqual(at('https://meet.google.com/abc-defg-hij'), ['googlemeet', 'abc-defg-hij']);
  assert.deepEqual(at('https://meet.google.com/landing'), ['googlemeet', null]);
  assert.deepEqual(at('https://app.zoom.us/wc/81234567890/join?pwd=x'), ['zoom', '81234567890']);
  assert.deepEqual(at('https://us02web.zoom.us/wc/81234567890/start'), ['zoom', '81234567890']);
  assert.deepEqual(at('https://zoom.us/j/81234567890'), ['zoom', null], 'a join link is not yet the web client');
  assert.deepEqual(at('https://zoom.us/profile/setting'), ['zoom', null]);
  for (const h of ['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft', 'gov.teams.microsoft.us']) {
    assert.deepEqual(at(`https://${h}/v2/`, '19:meeting_abc@thread.v2'), ['msteams', '19:meeting_abc@thread.v2'], h);
  }
  assert.deepEqual(at('https://teams.microsoft.com/v2/'), ['msteams', null], 'no id and no captions yet: not in a meeting');
  const ss = new Map(); const store = { getItem: (k) => ss.get(k) ?? null, setItem: (k, v) => ss.set(k, v) };
  const fallback = P.meetingCode('msteams', loc('https://teams.microsoft.com/v2/'), null, store);
  assert.match(fallback, /^call-[a-z0-9]+$/);
  assert.equal(P.meetingCode('msteams', loc('https://teams.microsoft.com/v2/'), null, store), fallback, 'stable per tab');
  assert.equal(P.meetingCode('msteams', loc('https://teams.microsoft.com/v2/'), 'x'.repeat(300)).length, 100, 'backend limit');
  for (const h of ['example.com', 'notzoom.us', 'zoom.us.evil.com', 'teams.microsoft.com.evil.com', 'upwork.com.evil.com', 'notupwork.com']) {
    assert.equal(P.platformOf(loc(`https://${h}/wc/81234567890/join`)), null, h);
  }
});

test('PLATFORM-01: Upwork video calls are identified by their meeting id; other Upwork pages are not meetings', () => {
  const P = loadPlatforms();
  const at = (url) => { const l = loc(url); const p = P.platformOf(l); return [p, P.meetingCode(p, l)]; };
  assert.deepEqual(at('https://www.upwork.com/nx/meeting/UVM_2126402354085493400'), ['upwork', 'UVM_2126402354085493400']);
  assert.deepEqual(at('https://www.upwork.com/nx/UVM_2126402354085493400'), ['upwork', 'UVM_2126402354085493400']);
  assert.deepEqual(at('https://www.upwork.com/nx/meeting/abc123XYZ/'), ['upwork', 'abc123XYZ']);
  assert.deepEqual(at('https://upwork.com/nx/meeting/UVM_42424242'), ['upwork', 'UVM_42424242']);
  for (const path of ['/nx/find-work/', '/nx/messages/rooms/room_1', '/nx/proposals/', '/nx/meeting/', '/nx/wm/workroom/123', '/ab/account-security']) {
    assert.deepEqual(at(`https://www.upwork.com${path}`), ['upwork', null], path);
  }
  assert.equal(P.NAMES.upwork, 'Upwork');
  assert.equal(P.linkKey('https://www.upwork.com/nx/meeting/UVM_2126402354085493400'), 'upwork:UVM_2126402354085493400');
  assert.equal(P.linkKey('https://www.upwork.com/nx/UVM_2126402354085493400?ref=msg'), 'upwork:UVM_2126402354085493400');
  assert.equal(P.linkKey('https://www.upwork.com/nx/find-work/'), null);
});

test('PLATFORM-01: host patterns are the bundled panel\'s own (content.js, rtcinjector.js)', () => {
  const src = read('sync/platforms.js');
  const zoom = src.match(/const ZOOM_HOST = (\/.+\/);/)[1];
  const teams = src.match(/const TEAMS_HOST = (\/.+\/);/)[1];
  for (const f of ['content.js', 'rtcinjector.js']) {
    const bundle = read(f);
    assert.ok(bundle.includes(zoom), `${f} uses the same Zoom host pattern`);
    assert.ok(bundle.includes(teams), `${f} uses the same Teams host pattern`);
  }
});

test('PLATFORM-01: meeting links shared on Upwork map to the meeting they open', () => {
  const P = loadPlatforms();
  assert.equal(P.linkKey('https://upwork.zoom.us/j/81234567890?pwd=abc'), 'zoom:81234567890');
  assert.equal(P.linkKey('https://zoom.us/s/81234567890'), 'zoom:81234567890');
  assert.equal(P.linkKey('https://us06web.zoom.us/wc/81234567890/join'), 'zoom:81234567890');
  assert.equal(P.linkKey('https://meet.google.com/abc-defg-hij?authuser=0'), 'googlemeet:abc-defg-hij');
  assert.equal(P.linkKey('https://teams.microsoft.com/l/meetup-join/19%3ameeting'), null);
  assert.equal(P.linkKey('https://zoom.us/pricing'), null);
  assert.equal(P.linkKey('javascript:alert(1)'), null);
  assert.equal(P.linkKey('not a url'), null);
});

// ---------------------------------------------------------------- PLATFORM-02 manifest

test('PLATFORM-02: Zoom and Teams get the same scripts, pages and permissions as Google Meet', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const MEETING_HOSTS = ['*://meet.google.com/*-*-*', '*://*.zoom.us/*', '*://teams.microsoft.com/*', '*://teams.live.com/*', '*://teams.cloud.microsoft/*'];
  const meetingEntries = manifest.content_scripts.filter((c) => c.js.some((f) => ['content.js', 'rtcinjector.js', 'sync/content.js'].includes(f)));
  assert.equal(meetingEntries.length, 3, 'panel, adapter injector and sync layer');
  for (const c of meetingEntries) {
    for (const h of MEETING_HOSTS) assert.ok(c.matches.includes(h), `${c.js[0]} runs on ${h}`);
  }
  assert.deepEqual(meetingEntries[0].matches, meetingEntries[1].matches);
  assert.deepEqual(meetingEntries[0].matches, meetingEntries[2].matches);
  assert.equal(meetingEntries.find((c) => c.js.includes('rtcinjector.js')).run_at, 'document_start', 'adapter hooks must be installed before the meeting app loads');
  for (const h of [...MEETING_HOSTS, '*://*.upwork.com/*']) assert.ok(manifest.host_permissions.includes(h), `host permission ${h}`);
  const war = manifest.web_accessible_resources.find((w) => w.resources.includes('auth.html'));
  for (const h of ['*://*.zoom.us/*', '*://teams.microsoft.com/*', '*://teams.live.com/*']) assert.ok(war.matches.includes(h), `pages reachable from ${h}`);
  const adapters = manifest.web_accessible_resources.find((w) => w.resources.includes('*.inline.js'));
  assert.ok(adapters, 'zoom.inline.js / msteams.inline.js can be injected into the page');
  for (const f of ['zoom.inline.js', 'msteams.inline.js', 'googlemeet.inline.js']) assert.doesNotThrow(() => read(f));
  const upwork = manifest.content_scripts.find((c) => c.js.includes('sync/upwork.js'));
  assert.deepEqual(upwork.matches, ['*://*.upwork.com/*']);
  assert.deepEqual(upwork.js, ['sync/platforms.js', 'sync/upwork.js']);
});

// ---------------------------------------------------------------- PLATFORM-03 Zoom links

test('PLATFORM-03: Zoom meeting links open in the web client (where captions can be read)', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const rs = manifest.declarative_net_request.rule_resources.find((r) => r.id === 'zoom_web_client');
  assert.ok(rs?.enabled, 'on by default');
  const rules = JSON.parse(read(rs.path));
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length, 'unique rule ids');
  // Same semantics as Chrome's regexSubstitution for these patterns: \N -> group N.
  const redirect = (url) => {
    for (const r of rules) {
      assert.deepEqual(r.condition.resourceTypes, ['main_frame']);
      const m = new RegExp(r.condition.regexFilter).exec(url);
      if (m) return r.action.redirect.regexSubstitution.replace(/\\(\d)/g, (_, i) => m[Number(i)] ?? '');
    }
    return url;
  };
  assert.equal(redirect('https://zoom.us/j/81234567890?pwd=abc'), 'https://zoom.us/wc/81234567890/join?pwd=abc');
  assert.equal(redirect('https://upwork.zoom.us/j/81234567890?pwd=abc'), 'https://upwork.zoom.us/wc/81234567890/join?pwd=abc');
  assert.equal(redirect('https://us02web.zoom.us/w/81234567890'), 'https://us02web.zoom.us/wc/81234567890/join');
  assert.equal(redirect('https://zoom.us/s/81234567890'), 'https://zoom.us/wc/81234567890/start');
  for (const url of ['https://zoom.us/wc/81234567890/join', 'https://zoom.us/signin', 'https://example.com/j/81234567890', 'https://zoom.us.evil.com/j/81234567890']) {
    assert.equal(redirect(url), url, `${url} is left alone`);
  }
  const html = read('settings.html');
  assert.match(html, /id="zoom-web-client"/, 'the redirect can be turned off in Settings');
  assert.match(read('settings.js'), /updateEnabledRulesets/);
});

// ---------------------------------------------------------------- PLATFORM-04 capture

test('PLATFORM-04: a Zoom web-client meeting is saved like a Google Meet one', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  await signedInWorker(browser, backend);
  const tab = meetingTab(browser, 'https://app.zoom.us/wc/81234567890/join?pwd=x');
  tab.emit({ type: 'title-updated', title: 'Weekly design review' });
  tab.speak('m1/u1', 'Can you walk us through the new onboarding flow?');
  tab.flush(); await settle(80);
  assert.deepEqual(backend.created().map(({ platform, meetingCode, title }) => ({ platform, meetingCode, title })), [{ platform: 'zoom', meetingCode: '81234567890', title: 'Weekly design review' }]);
  assert.deepEqual(backend.texts(), ['Can you walk us through the new onboarding flow?']);
  const cur = tab.ctx.MEETMEMO_SYNC.currentMeeting();
  assert.equal(cur.platform, 'zoom', 'Claude and the assist buttons address this meeting');
  assert.equal(tab.ctx.MEETMEMO_SYNC.recentLines().length, 1);
});

test('PLATFORM-04: a Zoom page outside a meeting saves nothing', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  await signedInWorker(browser, backend);
  const tab = meetingTab(browser, 'https://zoom.us/profile');
  tab.speak('m1', 'hello there everyone');
  tab.flush(); await settle(60);
  assert.equal(backend.created().length, 0);
  assert.equal(tab.ctx.MEETMEMO_SYNC.currentMeeting(), null);
});

test('PLATFORM-04: a Teams meeting is keyed by the adapter-reported id, with a per-tab fallback', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  await signedInWorker(browser, backend);
  const tab = meetingTab(browser, 'https://teams.microsoft.com/v2/');
  assert.equal(tab.ctx.MEETMEMO_SYNC.currentMeeting(), null, 'Teams chat, no call: not a meeting');
  tab.emit({ type: 'meeting-id', data: '19:meeting_NTk@thread.v2' });
  tab.speak('t1', 'What is the timeline for the migration?');
  tab.flush(); await settle(80);
  const [created] = backend.created();
  assert.equal(created.platform, 'msteams');
  assert.equal(created.meetingCode, '19:meeting_NTk@thread.v2');
  assert.match(created.title, /^Microsoft Teams 19:meeting_NTk@thread\.v2 — /);

  const browser2 = createBrowser(); const backend2 = meetingsBackend();
  await signedInWorker(browser2, backend2);
  const light = meetingTab(browser2, 'https://teams.live.com/light-meetings/launch');
  light.speak('t1', 'Shall we review the budget numbers now?');
  light.flush(); await settle(80);
  assert.equal(backend2.created()[0].platform, 'msteams');
  assert.match(backend2.created()[0].meetingCode, /^call-/, 'captions without a reported id still save');
});

// ---------------------------------------------------------------- PLATFORM-05 Upwork

function upworkPage(browser, url, hrefs) {
  const handlers = {};
  let observer;
  const ctx = runClassic(['sync/platforms.js', 'sync/upwork.js'], {
    chrome: browser.chromeFor({ url, tab: { id: 3 } }),
    location: loc(url),
    document: { readyState: 'complete', documentElement: {}, querySelectorAll: () => hrefs.map((href) => ({ href })) },
    addEventListener: (n, f) => { handlers[n] = f; },
    MutationObserver: class { constructor(f) { observer = f; } observe() {} },
  });
  return { ctx, handlers, mutate: () => observer?.() };
}

test('PLATFORM-05: Zoom calls shared in Upwork Messages are saved as Upwork client calls', async () => {
  const browser = createBrowser(); const backend = meetingsBackend();
  await signedInWorker(browser, backend);
  upworkPage(browser, 'https://www.upwork.com/ab/messages/rooms/room_1', [
    'https://upwork.zoom.us/j/81234567890?pwd=abc',
    'https://www.upwork.com/freelancers/~01',
  ]);
  await settle(20);
  const stored = browser.local.data.get('meetmemo_upwork_calls');
  assert.deepEqual(Object.keys(stored), ['zoom:81234567890'], 'only the meeting key is stored, no page content');

  const tab = meetingTab(browser, 'https://upwork.zoom.us/wc/81234567890/join');
  await settle(10);
  tab.emit({ type: 'title-updated', title: 'Website redesign' });
  tab.speak('u1', 'What budget did you have in mind for phase two?');
  tab.flush(); await settle(80);
  const [created] = backend.created();
  assert.equal(created.platform, 'zoom');
  assert.match(created.title, /^Upwork client call: Website redesign — /);

  // A different Zoom meeting is not labelled.
  const browser2 = createBrowser(); const backend2 = meetingsBackend();
  await signedInWorker(browser2, backend2);
  browser2.local.data.set('meetmemo_upwork_calls', { 'zoom:81234567890': Date.now() });
  const other = meetingTab(browser2, 'https://zoom.us/wc/99999999999/join');
  await settle(10);
  other.speak('o1', 'Any questions about the agenda today?');
  other.flush(); await settle(80);
  assert.match(backend2.created()[0].title, /^Zoom 99999999999 — /);
});

test('PLATFORM-05: the Upwork script does nothing outside upwork.com', async () => {
  const browser = createBrowser();
  upworkPage(browser, 'https://example.com/page', ['https://zoom.us/j/81234567890']);
  await settle(20);
  assert.equal(browser.local.data.has('meetmemo_upwork_calls'), false);
});

test('PLATFORM-05: Upwork entries expire and are capped', async () => {
  const browser = createBrowser();
  const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
  browser.local.data.set('meetmemo_upwork_calls', { 'zoom:11111111111': old });
  upworkPage(browser, 'https://www.upwork.com/ab/messages/rooms/r', ['https://zoom.us/j/22222222222']);
  await settle(20);
  assert.deepEqual(Object.keys(browser.local.data.get('meetmemo_upwork_calls')), ['zoom:22222222222']);
});

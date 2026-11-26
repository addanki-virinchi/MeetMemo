// Claude in the Google Meet panel — content-script side (classic; loaded after sync/content.js).
//
// The bundled panel (content.js) renders two empty placeholders in its tab bar:
//   [data-meetmemo-claude-toggle]  beside the "Claude" tab: the on/off switch
//   [data-meetmemo-claude-feed]    under the tabs: the newest answers, as translucent cards
// React never touches the inside of those elements, so this script mounts its own UI there in a
// shadow root (isolated from Meet's and the panel's CSS) and re-mounts whenever React re-creates
// them. It shows and controls only: the service worker (sync/live-worker.js) detects questions,
// asks the backend (which calls Claude) and streams the answer; this script receives state over
// the "meetmemo-claude" port. The full history stays in the live view (transcript.html?live=1).
(() => {
  const PORT_NAME = 'meetmemo-claude';
  const TOGGLE_SEL = '[data-meetmemo-claude-toggle]';
  const FEED_SEL = '[data-meetmemo-claude-feed]';
  const CLAUDE = '#D97757';

  const ERRORS = {
    ai_unavailable: "Claude isn't set up on the MeetMemo server.",
    ai_busy: 'Claude is busy. Try again in a minute.',
    ai_live_busy: 'Still answering earlier questions.',
    ai_rate_limited: 'Many questions in a short time, so answers paused for a few minutes.',
    ai_unreachable: "Couldn't reach Claude. Try again.",
    ai_timeout: 'Claude took too long to answer.',
    ai_declined: "Claude couldn't answer this one.",
    stream_cut: 'The connection dropped before the answer finished.',
    network: "Can't reach the MeetMemo server. If it was idle it can take up to a minute to wake up.",
    route_not_found: 'This MeetMemo server is out of date. Deploy the latest backend to get Claude answers.',
  };

  const CSS = `
    :host { all: initial; display: block; font: 13px/1.45 'Google Sans', Roboto, system-ui, sans-serif; color: #fff; }
    :host([data-kind="toggle"]) { display: flex; align-items: center; }
    button { font: inherit; color: inherit; }
    .switch { position: relative; width: 34px; height: 20px; margin: 0 6px; padding: 0; flex: none; border: 0; border-radius: 999px;
      background: #3c3d41; cursor: pointer; transition: background .15s; }
    .switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #b9bbbe; transition: transform .15s, background .15s; }
    .switch[aria-checked="true"] { background: ${CLAUDE}; }
    .switch[aria-checked="true"]::after { transform: translateX(14px); background: #fff; }
    .switch:disabled { opacity: .45; cursor: default; }
    .switch:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
    .feed { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    .feed[hidden] { display: none; }
    .bar { display: flex; align-items: center; gap: 8px; padding: 0 2px; color: #b9bbbe; font-size: 12px; }
    .bar .grow { flex: 1; min-width: 0; }
    .pulse { width: 7px; height: 7px; border-radius: 50%; background: ${CLAUDE}; flex: none; animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .35; } }
    .link { border: 0; background: none; padding: 0; color: #8ab4f8; font-size: 12px; cursor: pointer; }
    .link:hover { text-decoration: underline; }
    .cards { display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow-y: auto; scrollbar-width: thin; }
    .card { padding: 9px 11px; border: 1px solid rgba(255,255,255,.08); border-radius: 10px;
      background: rgba(49,50,55,.55); -webkit-backdrop-filter: blur(14px) saturate(1.3); backdrop-filter: blur(14px) saturate(1.3); }
    .card.newest { border-color: rgba(217,119,87,.45); }
    .q { margin: 0 0 4px; color: #b9bbbe; font-size: 12px; }
    .q b { color: #e8eaed; font-weight: 500; }
    .a p { margin: 0 0 4px; color: #fff; font-weight: 400; white-space: pre-wrap; overflow-wrap: anywhere; }
    .a p:last-child { margin-bottom: 0; }
    .caret { display: inline-block; width: 6px; height: 13px; margin-left: 2px; vertical-align: -2px; background: ${CLAUDE}; animation: pulse 1s steps(2) infinite; }
    .dots i { display: inline-block; width: 5px; height: 5px; margin-right: 3px; border-radius: 50%; background: #b9bbbe; animation: pulse 1.2s infinite; }
    .dots i:nth-child(2) { animation-delay: .2s; } .dots i:nth-child(3) { animation-delay: .4s; }
    .err { color: #f6aea9; }
    .note { margin: 0; padding: 8px 11px; border-radius: 10px; background: rgba(49,50,55,.55); color: #b9bbbe; font-size: 12px; }
    .note.warn { color: #fdd663; }
  `;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const clock = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

  let state = null; // last state from the worker; null = not known yet
  let port = null;
  let dead = false;
  let watching = null; // sessionId being watched
  let reconnectTimer = null;
  let busy = false; // a switch change is in flight
  const mounts = new Set(); // { host, kind, root }

  // ---- worker connection ----
  function connect() {
    if (port || dead) return port;
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      dead = true; // the extension was reloaded; this page needs a refresh
      return null;
    }
    port.onMessage.addListener((msg) => {
      if (msg?.type !== 'state') return;
      state = msg;
      busy = false;
      render();
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      watching = null;
      if (!dead && mounts.size && !reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; watch(); }, 1000);
    });
    return port;
  }

  function watch() {
    const meeting = self.MEETMEMO_SYNC?.currentMeeting?.();
    if (!meeting) return;
    const p = connect();
    if (!p || watching === meeting.sessionId) return;
    watching = meeting.sessionId;
    try { p.postMessage({ type: 'watch', meeting }); } catch { port = null; watching = null; }
  }

  function send(msg) {
    const p = connect();
    if (!p) return false;
    try { p.postMessage(msg); return true; } catch { port = null; return false; }
  }

  // ---- actions ----
  function onSwitch() {
    if (!state?.signedIn) { self.MEETMEMO_LINKS?.signIn('claude-switch'); return; }
    if (busy) return;
    busy = true;
    state = { ...state, on: !state.on };
    render();
    if (!send({ type: 'set', on: state.on })) { busy = false; state = { ...state, on: !state.on }; render(); }
  }
  const openAll = () => self.MEETMEMO_SYNC?.openTranscript();

  // ---- rendering ----
  function unavailable() {
    if (!state?.signedIn) return null;
    if (state.serverOutdated) return ERRORS.route_not_found;
    if (state.enabled === false) return ERRORS.ai_unavailable;
    return null;
  }

  function renderToggle(root) {
    let sw = root.querySelector('.switch');
    if (!sw) {
      sw = el('button', 'switch');
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.addEventListener('click', onSwitch);
      root.append(sw);
    }
    const off = unavailable();
    const on = !!state?.on && !off;
    sw.setAttribute('aria-checked', String(on));
    sw.disabled = !state || !!off;
    const label = !state ? 'Claude: connecting…'
      : !state.signedIn ? 'Sign in to use Claude'
        : off || (on ? 'Claude is answering questions in this meeting. Click to turn off.' : 'Turn on Claude to answer questions as they are asked.');
    sw.title = label;
    sw.setAttribute('aria-label', on ? 'Claude answers on' : 'Claude answers off');
  }

  function cardEl(c, newest) {
    const card = el('article', `card${newest ? ' newest' : ''}`);
    const q = el('p', 'q');
    const who = el('b', '', c.question?.speaker || 'Someone');
    q.append(who, `${c.question?.ts ? ` · ${clock(c.question.ts)}` : ''} — ${c.question?.text || ''}`);
    card.append(q);
    const a = el('div', 'a');
    if (c.status === 'answering' && !c.answer) {
      const dots = el('p', 'dots');
      dots.append(el('i'), el('i'), el('i'), 'Claude is answering…');
      a.append(dots);
    } else {
      const blocks = String(c.answer || '').trim().split(/\n{2,}/).filter((b) => b.trim());
      for (const b of blocks) a.append(el('p', '', b.replace(/\*\*(.+?)\*\*/g, '$1')));
      if (c.status === 'answering') (a.lastElementChild || a).append(el('span', 'caret'));
    }
    if (c.status === 'error') {
      const p = el('p', 'err', ERRORS[c.errorCode] || 'Something went wrong while answering.');
      if (!['ai_unavailable', 'route_not_found'].includes(c.errorCode)) {
        const retry = el('button', 'link', 'Retry');
        retry.type = 'button';
        retry.addEventListener('click', () => { retry.disabled = true; send({ type: 'retry', questionId: c.questionId }); });
        p.append(' ', retry);
      }
      a.append(p);
    }
    card.append(a);
    return card;
  }

  function renderFeed(root) {
    let feed = root.querySelector('.feed');
    if (!feed) { feed = el('section', 'feed'); feed.setAttribute('aria-label', 'Claude answers'); feed.setAttribute('aria-live', 'polite'); root.append(feed); }
    const off = unavailable();
    const cards = state?.cards || [];
    const show = !!state?.signedIn && (!!off || state.on || cards.length > 0);
    feed.hidden = !show;
    if (!show) { feed.replaceChildren(); return; }
    const cardsBox = feed.querySelector('.cards');
    const keep = cardsBox?.scrollTop || 0;
    const bar = el('div', 'bar');
    if (off) {
      feed.replaceChildren(el('p', 'note warn', off));
      return;
    }
    if (state.on) bar.append(el('span', 'pulse'), el('span', 'grow', cards.length ? 'Claude is listening' : 'Listening for questions…'));
    else bar.append(el('span', 'grow', 'Claude is off for this meeting'));
    const all = el('button', 'link', 'All answers');
    all.type = 'button';
    all.addEventListener('click', openAll);
    bar.append(all);
    const nodes = [bar];
    if (cards.length) {
      const box = el('div', 'cards');
      cards.forEach((c, i) => box.append(cardEl(c, i === 0)));
      nodes.push(box);
    } else if (state.on) {
      nodes.push(el('p', 'note', 'Ask a question out loud and Claude answers here. The question and a short excerpt of recent lines are sent to Claude; only you see the answers.'));
    }
    feed.replaceChildren(...nodes);
    const box = feed.querySelector('.cards');
    if (box) box.scrollTop = keep;
  }

  function render() {
    for (const m of [...mounts]) {
      if (!m.host.isConnected) { mounts.delete(m); continue; }
      if (m.kind === 'toggle') renderToggle(m.root); else renderFeed(m.root);
    }
  }

  // ---- mounting into the panel's placeholders ----
  function mount(host, kind) {
    if (host.shadowRoot || host.dataset.meetmemoMounted) return;
    host.dataset.meetmemoMounted = '1';
    host.setAttribute('data-kind', kind);
    const root = host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = CSS;
    root.append(style);
    mounts.add({ host, kind, root });
  }

  let scanTimer = null;
  function scan() {
    scanTimer = null;
    if (dead) return;
    const before = mounts.size;
    document.querySelectorAll(TOGGLE_SEL).forEach((h) => mount(h, 'toggle'));
    document.querySelectorAll(FEED_SEL).forEach((h) => mount(h, 'feed'));
    for (const m of [...mounts]) if (!m.host.isConnected) mounts.delete(m);
    if (!mounts.size) return;
    watch();
    if (mounts.size !== before) render();
  }
  const schedule = () => { if (!scanTimer) scanTimer = setTimeout(scan, 120); };

  function start() {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    schedule();
    // Meet changes meetings without a page load: follow the URL.
    setInterval(() => {
      if (!mounts.size) return;
      const s = self.MEETMEMO_SYNC?.currentMeeting?.()?.sessionId;
      if (s && s !== watching) watch();
    }, 2000);
  }

  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });
})();

// Claude tab assistant — content-script side (classic; loaded after sync/content.js).
//
// The bundled panel's Claude tab renders an empty placeholder [data-meetmemo-assist] where its
// three quick prompts used to be. React never touches the inside of that element, so this script
// mounts its own UI there in a shadow root and re-mounts whenever React re-creates it:
//
//   Ask this question   answers the other side's latest question
//   What to ask next    the best next question (prepared questions first, never a repeat)
//   Steer to close      a natural line that moves the call toward a next step
//
// Every answer appears in the same widget. Requests go to the service worker
// (sync/assist-worker.js) over the "meetmemo-assist" port with this tab's newest caption lines;
// the worker adds the account's token, and the backend adds the uploaded context documents.
(() => {
  const PORT_NAME = 'meetmemo-assist';
  const HOST_SEL = '[data-meetmemo-assist]';
  const CLAUDE = '#D97757';
  const MAX_PREVIOUS = 30;

  const ACTIONS = [
    {
      id: 'answer',
      label: 'Ask this question',
      hint: "Answer the client's latest question",
      icon: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.7-.8 1.2V14"/><path d="M12 17h.01"/>',
      result: 'Suggested answer',
    },
    {
      id: 'next',
      label: 'What to ask next',
      hint: 'The best follow-up for this moment',
      icon: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
      result: 'Ask next',
    },
    {
      id: 'close',
      label: 'Steer to close',
      hint: 'Move toward a concrete next step',
      icon: '<path d="M4 21V4"/><path d="M4 4h12l-2 4 2 4H4"/>',
      result: 'Steer to close',
    },
  ];
  const byId = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

  const ERRORS = {
    signed_out: 'Sign in to MeetMemo to use Claude.',
    account_changed: 'The signed-in account changed. Try again.',
    no_meeting: 'Join the meeting to use the assistant.',
    ai_unavailable: "Claude isn't set up on the MeetMemo server.",
    ai_busy: 'Claude is busy. Try again in a moment.',
    ai_timeout: 'Claude took too long. Try again.',
    timeout: 'The MeetMemo server took too long to respond. Try again.',
    ai_rate_limited: 'Many requests in a short time. Try again in a few minutes.',
    ai_declined: "Claude couldn't help with this one.",
    ai_unreachable: "Couldn't reach Claude. Try again.",
    empty_answer: 'No suggestion came back. Try again.',
    network: "Can't reach the MeetMemo server. If it was idle it can take up to a minute to wake up.",
    route_not_found: 'This MeetMemo server is out of date. Deploy the latest backend to use these actions.',
    not_found: 'This meeting is no longer in your account.',
    internal_error: 'The MeetMemo server hit an error. Try again in a moment.',
  };

  const CSS = `
    :host { all: initial; display: block; font: 13px/1.45 'Google Sans', Roboto, system-ui, sans-serif; color: #f4f4f5; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button { font: inherit; color: inherit; }
    button:focus-visible { outline: 2px solid #cfb8ff; outline-offset: 2px; }
    .head { display: flex; align-items: baseline; gap: 8px; margin: 0 0 10px; }
    .title { margin-inline-end: auto; color: #a1a1aa; font-size: 13px; }
    .docs { padding: 0; border: 0; background: none; color: #a1a1aa; font-size: 12px; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
    .docs:hover { color: #f4f4f5; }
    .actions { display: grid; gap: 8px; }
    .act { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 12px; text-align: left;
      background: #1f1f23; border: 1px solid #3c3d41; border-radius: 8px; cursor: pointer; transition: background .12s, border-color .12s; }
    .act:hover:not(:disabled) { background: #29292e; border-color: #4a4b50; }
    .act:disabled { cursor: default; opacity: .55; }
    .act[aria-busy="true"] { opacity: 1; border-color: ${CLAUDE}; }
    .act svg { width: 16px; height: 16px; flex: none; color: #d4d4d8; }
    .act[aria-busy="true"] svg { color: ${CLAUDE}; }
    .act span { display: flex; flex-direction: column; min-width: 0; }
    .act b { font-weight: 500; font-size: 14px; color: #fff; }
    .act small { color: #a1a1aa; font-size: 12px; }
    .result { margin-top: 12px; padding: 12px; border-radius: 10px; background: #232129; border: 1px solid rgba(214, 195, 250, .22); }
    .label { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; color: #e4daff; font-size: 12px; font-weight: 500; }
    .label::before { content: '✳'; color: ${CLAUDE}; font-size: 14px; }
    .label time { color: #a1a1aa; font-weight: 400; }
    .q { margin: 0 0 8px; color: #c4c4cc; font-size: 12.5px; font-style: italic; }
    .text { margin: 0; color: #fff0da; font-size: 15px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
    .text.muted { color: #d4d4d8; font-size: 13.5px; }
    .note { margin: 8px 0 0; color: #b9b9c3; font-size: 12.5px; }
    .note b { color: #e4e4e7; font-weight: 500; }
    .error { margin: 0; color: #ffd2ca; }
    .foot { display: flex; align-items: center; gap: 4px; margin-top: 10px; flex-wrap: wrap; }
    .ctx { margin-inline-start: auto; color: #8b8b95; font-size: 11.5px; }
    .link { padding: 3px 7px; border: 0; border-radius: 5px; background: transparent; color: #e3d1ff; font-size: 12px; cursor: pointer; }
    .link:hover { background: rgba(255,255,255,.1); }
    .skeleton { display: grid; gap: 7px; }
    .skeleton i { display: block; height: 11px; border-radius: 4px; background: linear-gradient(90deg, #2e2c36 0%, #3a3745 50%, #2e2c36 100%); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; }
    .skeleton i:nth-child(2) { width: 85%; }
    .skeleton i:nth-child(3) { width: 60%; }
    @keyframes shimmer { to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) { .skeleton i { animation: none; } }
  `;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const svg = (paths) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = paths; // static markup only, never user data
    return s;
  };
  const clock = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

  // ---- state (module-wide, so a re-mounted placeholder shows the same thing) ----
  const meetings = new Map(); // sessionId -> { previous: [{action, text}], last }
  let busy = null; // action id in flight
  let current = null; // { action, at, data } | { action, at, error } | { action, at, loading: true }
  let docs = null; // { active, total } | null when unknown
  let docsAt = 0;
  const mounts = new Set(); // { host, root, update }

  function meetingState() {
    const m = self.MEETMEMO_SYNC?.currentMeeting?.();
    if (!m) return null;
    if (!meetings.has(m.sessionId)) meetings.set(m.sessionId, { previous: [], last: null });
    return { meeting: m, st: meetings.get(m.sessionId) };
  }

  // ---- worker connection: one request/response per click ----
  let port = null;
  let dead = false;
  let seq = 0;
  const waiting = new Map(); // reqId -> resolve
  function connect() {
    if (port || dead) return port;
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      dead = true; // the extension was reloaded; this page needs a refresh
      return null;
    }
    port.onMessage.addListener((msg) => {
      const done = waiting.get(msg?.reqId);
      if (!done) return;
      waiting.delete(msg.reqId);
      done(msg);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      for (const done of waiting.values()) done({ ok: false, error: { code: 'network' } });
      waiting.clear();
    });
    return port;
  }
  function request(msg) {
    return new Promise((resolve) => {
      const p = connect();
      if (!p) { resolve({ ok: false, error: { code: 'reload' } }); return; }
      const reqId = ++seq;
      waiting.set(reqId, resolve);
      try { p.postMessage({ ...msg, reqId }); } catch { waiting.delete(reqId); resolve({ ok: false, error: { code: 'network' } }); }
    });
  }

  async function refreshDocs(force = false) {
    if (!force && Date.now() - docsAt < 60_000) return;
    docsAt = Date.now();
    const r = await request({ type: 'docs' });
    if (r.ok) { docs = r.data; render(); }
  }

  async function run(action) {
    if (busy) return;
    const ctx = meetingState();
    if (!ctx) { current = { action, at: Date.now(), error: { code: 'no_meeting' } }; render(); return; }
    busy = action;
    current = { action, at: Date.now(), loading: true };
    render();
    const r = await request({
      type: 'assist',
      action,
      meeting: ctx.meeting,
      lines: self.MEETMEMO_SYNC?.recentLines?.(600) || [],
      userName: self.MEETMEMO_SYNC?.userName?.() || undefined,
      previous: ctx.st.previous,
    });
    busy = null;
    if (r.ok) {
      current = { action, at: Date.now(), data: r.data };
      const said = r.data.text && !(action === 'answer' && r.data.found === false);
      if (said) {
        ctx.st.previous.push({ action, text: r.data.text });
        if (ctx.st.previous.length > MAX_PREVIOUS) ctx.st.previous.shift();
      }
      if (r.data.context) { docs = { ...(docs || {}), active: r.data.context.documents }; docsAt = Date.now(); }
    } else {
      current = { action, at: Date.now(), error: r.error || { code: 'failed' } };
    }
    ctx.st.last = current;
    render();
  }

  // ---- rendering ----
  function mountUi(root) {
    const wrap = el('section');
    wrap.setAttribute('aria-label', 'Claude meeting assistant');
    const head = el('div', 'head');
    const title = el('span', 'title', 'This Meeting');
    const docsLink = el('button', 'docs');
    docsLink.type = 'button';
    docsLink.title = 'Upload or manage the documents Claude uses as context (Meetings page)';
    docsLink.addEventListener('click', () => self.MEETMEMO_LINKS?.openPage('history'));
    head.append(title, docsLink);

    const actions = el('div', 'actions');
    const buttons = ACTIONS.map((a) => {
      const b = el('button', 'act');
      b.type = 'button';
      b.dataset.action = a.id;
      const txt = el('span');
      txt.append(el('b', '', a.label), el('small', '', a.hint));
      b.append(svg(a.icon), txt);
      b.addEventListener('click', () => run(a.id));
      actions.append(b);
      return b;
    });

    const result = el('div', 'result');
    result.setAttribute('aria-live', 'polite');
    const label = el('p', 'label');
    const labelText = el('span');
    const labelTime = el('time');
    label.append(labelText, labelTime);
    const skeleton = el('div', 'skeleton');
    skeleton.append(el('i'), el('i'), el('i'));
    const q = el('p', 'q');
    const text = el('p', 'text');
    const note = el('p', 'note');
    const error = el('p', 'error');
    const foot = el('div', 'foot');
    const copy = el('button', 'link', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text.textContent);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      } catch { /* clipboard blocked */ }
    });
    const again = el('button', 'link', 'Try again');
    again.type = 'button';
    again.addEventListener('click', () => current && run(current.action));
    const signIn = el('button', 'link', 'Sign in');
    signIn.type = 'button';
    signIn.addEventListener('click', () => self.MEETMEMO_LINKS?.signIn('claude-switch'));
    const ctxInfo = el('span', 'ctx');
    foot.append(copy, again, signIn, ctxInfo);
    result.append(label, skeleton, q, text, note, error, foot);

    wrap.append(head, actions, result);
    root.append(wrap);

    return () => {
      const known = docs && typeof docs.active === 'number';
      docsLink.textContent = !known ? 'Meeting documents'
        : docs.active === 0 ? 'Add meeting documents'
          : `Using ${docs.active} document${docs.active === 1 ? '' : 's'}`;

      for (const b of buttons) {
        b.disabled = !!busy;
        b.setAttribute('aria-busy', String(busy === b.dataset.action));
      }

      result.hidden = !current;
      if (!current) return;
      const meta = byId[current.action];
      labelText.textContent = meta.result;
      labelTime.textContent = clock(current.at);
      skeleton.hidden = !current.loading;

      const d = current.data;
      const err = current.error;
      const noQuestion = d && current.action === 'answer' && d.found === false;
      q.hidden = !(d && current.action === 'answer' && d.found !== false && d.question);
      q.textContent = q.hidden ? '' : `“${d.question}”`;
      text.hidden = !d;
      text.textContent = d ? d.text : '';
      text.classList.toggle('muted', !!noQuestion);

      note.replaceChildren();
      if (d && current.action === 'next' && d.why) note.append(el('b', '', 'Why: '), d.why);
      if (d && current.action === 'next' && d.covered?.length) {
        if (note.childNodes.length) note.append(el('br'));
        note.append(el('b', '', 'Covered: '), d.covered.join(', '));
      }
      if (d && current.action === 'close' && d.nextStep) note.append(el('b', '', 'Next step: '), d.nextStep);
      note.hidden = !note.childNodes.length;

      error.hidden = !err;
      error.textContent = err ? (err.code === 'reload' ? 'MeetMemo was updated. Refresh this page to use Claude.' : ERRORS[err.code] || err.message || 'Something went wrong. Try again.') : '';

      foot.hidden = !!current.loading;
      copy.hidden = !d || !!noQuestion;
      again.hidden = !!(err && ['signed_out', 'reload', 'route_not_found', 'ai_unavailable'].includes(err.code));
      signIn.hidden = !(err && err.code === 'signed_out');
      const c = d?.context;
      ctxInfo.textContent = c ? `${c.documents} doc${c.documents === 1 ? '' : 's'} · ${c.lines} line${c.lines === 1 ? '' : 's'}${c.omitted?.length || c.cut?.length ? ' · some documents did not fit' : ''}` : '';
    };
  }

  function render() {
    for (const m of [...mounts]) {
      if (!m.host.isConnected) { mounts.delete(m); continue; }
      m.update();
    }
  }

  function mount(host) {
    if (host.shadowRoot || host.dataset.meetmemoMounted) return false;
    host.dataset.meetmemoMounted = '1';
    const root = host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = CSS;
    root.append(style);
    const update = mountUi(root);
    mounts.add({ host, root, update });
    // A different meeting in this tab: show that meeting's last result, not the previous one's.
    const ctx = meetingState();
    if (!busy) current = ctx?.st.last || null;
    update();
    return true;
  }

  let scanTimer = null;
  function scan() {
    scanTimer = null;
    let mounted = false;
    for (const host of document.querySelectorAll(HOST_SEL)) mounted = mount(host) || mounted;
    for (const m of [...mounts]) if (!m.host.isConnected) mounts.delete(m);
    if (mounted) refreshDocs().catch(() => {});
  }
  const schedule = () => { if (!scanTimer) scanTimer = setTimeout(scan, 120); };

  function start() {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    // Documents uploaded on the Meetings page while this tab is open are picked up on return.
    document.addEventListener('visibilitychange', () => { if (!document.hidden && mounts.size) refreshDocs(true).catch(() => {}); });
    schedule();
  }

  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });
})();

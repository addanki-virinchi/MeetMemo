// Claude tab assistant — content-script side (classic; loaded after sync/content.js).
//
// The bundled panel's Claude tab renders an empty placeholder [data-meetmemo-assist] where its
// three quick prompts used to be. React never touches the inside of that element, so this script
// mounts its own UI there in a shadow root and re-mounts whenever React re-creates it:
//
//   Answer Client            answers the other side's latest question
//   Next Best Question       the best next question (prepared questions first, never a repeat)
//   Close the Conversation   a natural line that moves the call toward a next step
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
      label: 'Answer Client',
      hint: "Reply to the client's latest question",
      icon: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.7-.8 1.2V14"/><path d="M12 17h.01"/>',
      result: 'Answer for the client',
    },
    {
      id: 'next',
      label: 'Next Best Question',
      hint: 'The most useful follow-up, never a repeat',
      icon: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
      result: 'Next best question',
    },
    {
      id: 'close',
      label: 'Close the Conversation',
      hint: 'Guide toward a proposal, call or decision',
      icon: '<path d="M4 21V4"/><path d="M4 4h12l-2 4 2 4H4"/>',
      result: 'Closing line',
    },
  ];
  const byId = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

  // Model picker (shared with the live answers and Ask Meet Memo through meetmemo_prefs).
  const PREFS_KEY = 'meetmemo_prefs';
  const MODELS = [
    { id: 'claude-haiku-5-5', name: 'Haiku 5.5', hint: 'Fastest answers, lowest cost' },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', hint: 'Balanced speed and depth' },
    { id: 'claude-opus-5-5', name: 'Opus 5.5', hint: 'Most capable, slowest' },
  ];
  const EFFORTS = [
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
  ];
  const DEFAULT_MODEL = MODELS[0].id;
  const DEFAULT_EFFORT = 'low';
  const modelName = (id) => MODELS.find((m) => m.id === id)?.name || 'Claude';
  const effortName = (id) => EFFORTS.find((e) => e.id === id)?.name || '';

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
    .picker { position: relative; margin: 0 0 10px; }
    .pick { display: flex; align-items: center; gap: 7px; width: 100%; padding: 7px 10px; text-align: left;
      background: #1f1f23; border: 1px solid #3c3d41; border-radius: 8px; cursor: pointer; }
    .pick:hover { background: #29292e; border-color: #4a4b50; }
    .pick .spark { color: ${CLAUDE}; font-size: 15px; line-height: 1; }
    .pick b { font-weight: 500; color: #fff; }
    .pick .eff { color: #a1a1aa; font-size: 12px; }
    .pick .chev { margin-inline-start: auto; color: #a1a1aa; transition: transform .12s; }
    .pick[aria-expanded="true"] .chev { transform: rotate(180deg); }
    .menu { position: absolute; z-index: 2; top: calc(100% + 4px); left: 0; right: 0; padding: 6px;
      background: #26252c; border: 1px solid #45444d; border-radius: 10px; box-shadow: 0 10px 28px rgba(0,0,0,.5); }
    .menu h3 { margin: 4px 8px; color: #a1a1aa; font-size: 11.5px; font-weight: 500; }
    .opt { display: grid; grid-template-columns: 1fr 16px; align-items: center; width: 100%; padding: 7px 8px;
      border: 0; border-radius: 6px; background: transparent; text-align: left; cursor: pointer; }
    .opt:hover, .opt:focus-visible { background: #33323b; }
    .opt b { font-weight: 500; color: #fff; font-size: 13.5px; }
    .opt small { grid-column: 1; color: #a1a1aa; font-size: 12px; }
    .opt .tick { grid-column: 2; grid-row: 1 / span 2; color: ${CLAUDE}; visibility: hidden; }
    .opt[aria-checked="true"] .tick { visibility: visible; }
    .sep { height: 1px; margin: 6px 2px; background: #3c3d41; }
    .seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; margin: 2px 6px 6px; padding: 2px;
      background: #1b1b1f; border-radius: 7px; }
    .seg button { padding: 5px 0; border: 0; border-radius: 5px; background: transparent; color: #c4c4cc; font-size: 12.5px; cursor: pointer; }
    .seg button[aria-checked="true"] { background: #3a3943; color: #fff; }
    .menu p { margin: 0 8px 4px; color: #8b8b95; font-size: 11.5px; }
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
  let choice = { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT };

  function readChoice(prefs) {
    const p = prefs && typeof prefs === 'object' ? prefs : {};
    choice = {
      model: MODELS.some((m) => m.id === p.aiModel) ? p.aiModel : DEFAULT_MODEL,
      effort: EFFORTS.some((e) => e.id === p.aiEffort) ? p.aiEffort : DEFAULT_EFFORT,
    };
  }
  async function saveChoice(patch) {
    choice = { ...choice, ...patch };
    render();
    try {
      const prev = (await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY];
      const next = { ...(prev && typeof prev === 'object' ? prev : {}) };
      if (patch.model) next.aiModel = patch.model;
      if (patch.effort) next.aiEffort = patch.effort;
      await chrome.storage.local.set({ [PREFS_KEY]: next });
    } catch { /* extension reloaded: the choice still applies on this page */ }
  }

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
    const asked = { model: choice.model, effort: choice.effort };
    current = { action, at: Date.now(), loading: true, ...asked };
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
      current = { action, at: Date.now(), data: r.data, ...asked };
      const said = r.data.text && !(action === 'answer' && r.data.found === false);
      if (said) {
        ctx.st.previous.push({ action, text: r.data.text });
        if (ctx.st.previous.length > MAX_PREVIOUS) ctx.st.previous.shift();
      }
      if (r.data.context) { docs = { ...(docs || {}), active: r.data.context.documents }; docsAt = Date.now(); }
    } else {
      current = { action, at: Date.now(), error: r.error || { code: 'failed' }, ...asked };
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

    // ---- model picker: "✳ Sonnet 5.5 · Medium effort ▾" opens a menu of models and effort ----
    const picker = el('div', 'picker');
    const pick = el('button', 'pick');
    pick.type = 'button';
    pick.title = 'Choose which Claude model answers, and how hard it thinks';
    pick.setAttribute('aria-haspopup', 'true');
    pick.setAttribute('aria-expanded', 'false');
    const spark = el('span', 'spark', '✳');
    spark.setAttribute('aria-hidden', 'true');
    const pickName = el('b');
    const pickEffort = el('span', 'eff');
    const chev = el('span', 'chev', '▾');
    chev.setAttribute('aria-hidden', 'true');
    pick.append(spark, pickName, pickEffort, chev);

    const menu = el('div', 'menu');
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Claude model and effort');
    const modelOpts = MODELS.map((m) => {
      const b = el('button', 'opt');
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.dataset.model = m.id;
      const tick = el('span', 'tick', '✓');
      tick.setAttribute('aria-hidden', 'true');
      b.append(el('b', '', m.name), tick, el('small', '', m.hint));
      b.addEventListener('click', () => saveChoice({ model: m.id }));
      return b;
    });
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Effort');
    const effortOpts = EFFORTS.map((e) => {
      const b = el('button', '', e.name);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.effort = e.id;
      b.addEventListener('click', () => saveChoice({ effort: e.id }));
      seg.append(b);
      return b;
    });
    menu.append(
      el('h3', '', 'Model'), ...modelOpts, el('div', 'sep'),
      el('h3', '', 'Effort'), seg,
      el('p', '', 'Higher effort thinks longer before answering: slower, often more accurate. Also used for live answers and Ask Meet Memo.'),
    );
    picker.append(pick, menu);

    const setOpen = (open) => {
      menu.hidden = !open;
      pick.setAttribute('aria-expanded', String(open));
      if (open) (modelOpts.find((b) => b.dataset.model === choice.model) || modelOpts[0]).focus();
    };
    pick.addEventListener('click', () => setOpen(menu.hidden));
    picker.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); setOpen(false); pick.focus(); }
    });
    // Close on any click outside the picker (composedPath sees through the shadow root).
    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !e.composedPath().includes(picker)) setOpen(false);
    }, true);

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

    wrap.append(head, picker, actions, result);
    root.append(wrap);

    return () => {
      const known = docs && typeof docs.active === 'number';
      docsLink.textContent = !known ? 'Meeting documents'
        : docs.active === 0 ? 'Add meeting documents'
          : `Using ${docs.active} document${docs.active === 1 ? '' : 's'}`;

      pickName.textContent = modelName(choice.model);
      pickEffort.textContent = `· ${effortName(choice.effort)} effort`;
      for (const b of modelOpts) b.setAttribute('aria-checked', String(b.dataset.model === choice.model));
      for (const b of effortOpts) b.setAttribute('aria-checked', String(b.dataset.effort === choice.effort));

      for (const b of buttons) {
        b.disabled = !!busy;
        b.setAttribute('aria-busy', String(busy === b.dataset.action));
      }

      result.hidden = !current;
      if (!current) return;
      const meta = byId[current.action];
      labelText.textContent = meta.result;
      // Which model and effort produced this result, so answers can be compared.
      const usedModel = current.data?.model || current.model;
      const usedEffort = current.data?.effort || current.effort;
      labelTime.textContent = [clock(current.at), usedModel && modelName(usedModel), usedEffort && effortName(usedEffort)].filter(Boolean).join(' · ');
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
    try {
      chrome.storage.local.get(PREFS_KEY).then((r) => { readChoice(r[PREFS_KEY]); render(); }, () => {});
      chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && PREFS_KEY in c) { readChoice(c[PREFS_KEY].newValue); render(); } });
    } catch { /* extension reloaded */ }
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    // Documents uploaded on the Meetings page while this tab is open are picked up on return.
    document.addEventListener('visibilitychange', () => { if (!document.hidden && mounts.size) refreshDocs(true).catch(() => {}); });
    schedule();
  }

  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });
})();

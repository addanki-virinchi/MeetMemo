// Claude in the meeting panel (Meet, Zoom, Teams) — content-script side (classic; loaded after sync/content.js).
//
// The bundled panel (content.js) renders two empty placeholders:
//   [data-meetmemo-claude-toggle]  beside the "Claude" tab: the on/off switch
//   [data-meetmemo-claude-feed]    marks the live transcript viewport for positioning
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
  // The draggable answer overlay (mountOverlay below) is kept but not shown in the Meet panel.
  // Set to true to bring it back; the Claude switch and the live view are unaffected.
  const SHOW_OVERLAY = false;

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
    :host([data-kind="feed"]) { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
      font: 14px/1.5 'Segoe UI', system-ui, sans-serif; }
    [hidden] { display: none !important; }
    .sheet { position: absolute; box-sizing: border-box;
      display: flex; flex-direction: column; overflow: hidden; pointer-events: auto;
      border: 1px solid rgba(214, 195, 250, .36); border-radius: 14px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .45); }
    .header { display: flex; align-items: center; flex-wrap: wrap; flex: none; gap: 6px;
      padding: 6px 9px; border-bottom: 1px solid rgba(214, 195, 250, .2);
      background: rgba(34, 33, 45, .93); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
      cursor: grab; touch-action: none; user-select: none; }
    .sheet.dragging .header { cursor: grabbing; }
    .name { font-weight: 650; margin-inline-end: auto; }
    .mark { color: ${CLAUDE}; font-size: 17px; }
    .status { color: #e4daff; font-size: 11px; }
    .status.live::before { content: ''; display: inline-block; margin-inline-end: 4px;
      width: 6px; height: 6px; border-radius: 50%; background: #73e1a0; }
    .icon { padding: 0; min-width: 25px; min-height: 25px; font-size: 16px; line-height: 1; }
    .icon, .link { background: transparent; border: 0; border-radius: 5px; cursor: pointer; }
    .icon:hover, .link:hover { background: rgba(255,255,255,.13); }
    button:focus-visible, .body:focus-visible { outline: 2px solid #cfb8ff; outline-offset: -2px; }
    .body { min-block-size: 0; overflow-y: auto; overscroll-behavior-y: contain;
      scrollbar-width: thin; scrollbar-color: #a595bc transparent; padding: 12px 14px;
      background: #191a22; }
    .body:focus-visible { outline-offset: -3px; }
    .q { margin: 0 0 8px; color: #bfc3d1; font-size: 12px; }
    .answer { margin: 0; color: #fff0da; font-size: 15px; font-weight: 400; line-height: 1.6;
      white-space: pre-wrap; overflow-wrap: anywhere; }
    .answer code { font: .92em/1.5 Consolas, ui-monospace, monospace; color: #d8c5ff;
      background: #2b2639; border-radius: 3px; padding: 0 3px; }
    .answer.streaming::after { content: ''; display: inline-block; vertical-align: -2px;
      width: 5px; height: 12px; margin-left: 3px; background: ${CLAUDE}; animation: pulse 1s steps(2) infinite; }
    @keyframes pulse { 50% { opacity: .35; } }
    .link { padding: 3px 5px; color: #e3d1ff; font-size: 11px; }
    .error { margin: 6px 0 0; color: #ffd2ca; }
    .reopen { position: absolute; padding: 5px 9px;
      background: #242233; border: 1px solid rgba(214, 195, 250, .35); pointer-events: auto; }
    @media (prefers-reduced-motion: reduce) { .answer.streaming::after { animation: none; } }
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
    state = null;
    watching = meeting.sessionId;
    render();
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

  function mountOverlay(root, anchor) {
    const sheet = el('section', 'sheet');
    sheet.setAttribute('aria-label', 'Claude live answer');
    const header = el('div', 'header');
    const mark = el('span', 'mark', '✳');
    mark.setAttribute('aria-hidden', 'true');
    const status = el('span', 'status');
    status.setAttribute('role', 'status');
    const body = el('div', 'body');
    body.tabIndex = 0;
    body.setAttribute('role', 'region');
    body.setAttribute('aria-label', 'Claude response');
    const question = el('p', 'q');
    const answer = el('p', 'answer');
    const error = el('p', 'error');

    function action(cls, text, label, handler) {
      const button = el('button', cls, text);
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', handler);
      return button;
    }

    let mode = 'auto';
    let placement = { kind: 'auto' };
    let drag;
    let lastAnswer = null;
    let lastId = null;
    let lastMeeting = null;
    let wasOn = false;
    let current;
    const all = action('link', 'All answers', 'Open all Claude answers', openAll);
    const dock = (kind) => {
      placement = { kind };
      mode = 'expanded';
      render();
    };
    const left = action('icon', '←', 'Dock left', () => dock('left'));
    const right = action('icon', '→', 'Dock right', () => dock('right'));
    const minimize = action('icon', '−', 'Minimize Claude overlay', () => {
      mode = mode === 'minimized' ? 'expanded' : 'minimized';
      render();
    });
    const close = action('icon', '×', 'Hide Claude overlay', () => {
      mode = 'closed';
      render();
      reopen.focus();
    });
    const reopen = action('link reopen', 'Show Claude', 'Show Claude overlay', () => {
      mode = 'expanded';
      render();
      minimize.focus();
    });
    const retry = action('link', 'Retry', 'Retry Claude answer', () => {
      if (current && send({ type: 'retry', questionId: current.questionId })) retry.disabled = true;
    });
    header.append(mark, el('strong', 'name', 'Claude'), status, all, minimize, close, left, right);
    body.append(question, answer, error, retry);
    sheet.append(header, body);
    root.append(sheet, reopen);

    function setText(node, text) {
      if (node.textContent !== text) node.textContent = text;
    }

    function updateAnswer(text) {
      if (text === lastAnswer) return;
      lastAnswer = text;
      const parts = text.split(/(`[^`\n]+`)/);
      answer.replaceChildren(...parts.map((part, i) => i % 2 ? el('code', '', part.slice(1, -1)) : part));
    }

    const gap = 12;
    const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
    function viewport() {
      const { innerWidth: width, innerHeight: height } = window;
      const rect = anchor.parentElement.getBoundingClientRect();
      const bottom = Math.max(gap + 65, height - Math.min(118, Math.round(height * .23)));
      return { width, height, rect, bottom };
    }

    function position({ width, height, rect, bottom }) {
      const panelWidth = Math.min(368, Math.max(0, width - gap * 2));
      const maxLeft = width - panelWidth - gap;
      const rightSpace = width - rect.right - gap * 2;
      const leftSpace = rect.left - gap * 2;
      const beside = panelWidth >= 280 && Math.max(leftSpace, rightSpace) >= panelWidth;
      const insideLeft = rect.left - panelWidth - gap;
      const insideRight = rect.right + gap;
      const nearTranscript = rightSpace >= panelWidth ? insideRight : insideLeft;
      const narrowTop = Math.min(bottom - 60, gap + 36);
      const autoTop = beside ? clamp(rect.top, gap, bottom - 125) : Math.max(gap, narrowTop);
      let x = nearTranscript;
      if (placement.kind === 'left') x = gap;
      if (placement.kind === 'right') x = !beside || rightSpace >= panelWidth ? maxLeft : insideLeft;
      if (placement.kind === 'float') x = placement.x;
      const y = placement.kind === 'float' ? placement.y : autoTop;
      const top = clamp(y, gap, bottom - Math.min(150, Math.round(height * .35)));
      sheet.style.left = `${clamp(x, gap, maxLeft)}px`;
      sheet.style.top = `${top}px`;
      sheet.style.width = `${panelWidth}px`;
      const availableHeight = bottom - top;
      sheet.style.maxHeight = `${beside || placement.kind === 'float' ? availableHeight : Math.min(availableHeight, Math.round(height * .65))}px`;
      reopen.style.right = `${clamp(width - rect.right + gap, gap, width - 165)}px`;
      reopen.style.top = `${clamp(rect.top + 6, gap, bottom - 35)}px`;
      return beside;
    }

    header.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary || event.target.closest('button')) return;
      const { left: x, top: y } = sheet.getBoundingClientRect();
      drag = { id: event.pointerId, dx: event.clientX - x, dy: event.clientY - y };
      header.setPointerCapture(event.pointerId);
      sheet.classList.add('dragging');
      event.preventDefault();
    });
    header.addEventListener('pointermove', (event) => {
      if (drag?.id !== event.pointerId) return;
      placement = { kind: 'float', x: event.clientX - drag.dx, y: event.clientY - drag.dy };
      position(viewport());
    });
    function finishDrag(event) {
      if (drag?.id !== event.pointerId) return;
      drag = null;
      sheet.classList.remove('dragging');
      if (event.type !== 'pointerup' || placement.kind !== 'float') return;
      const rect = sheet.getBoundingClientRect();
      if (rect.left <= gap + 24) dock('left');
      else if (window.innerWidth - rect.right <= gap + 24) dock('right');
    }
    header.addEventListener('pointerup', finishDrag);
    header.addEventListener('pointercancel', finishDrag);
    header.addEventListener('lostpointercapture', finishDrag);

    return () => {
      const warning = unavailable();
      const active = !!state?.signedIn && !!state.on;
      const meeting = active ? watching : null;
      if (meeting !== lastMeeting || (active && !wasOn)) {
        mode = 'auto';
        lastMeeting = meeting;
      }
      wasOn = active;
      const metrics = viewport();
      const visible = active && metrics.rect.width > 0 && metrics.rect.height > 0;
      const beside = position(metrics);
      const compact = mode === 'closed' || (mode === 'auto' && !beside);
      sheet.hidden = !visible || compact;
      reopen.hidden = !visible || !compact;
      if (!reopen.hidden) {
        setText(reopen, state.cards?.length ? 'Claude answer ready' : 'Show Claude');
      }
      if (sheet.hidden) return;

      const expanded = mode !== 'minimized';
      body.hidden = !expanded;
      minimize.textContent = expanded ? '−' : '+';
      minimize.title = expanded ? 'Minimize Claude overlay' : 'Expand Claude overlay';
      minimize.setAttribute('aria-label', minimize.title);
      minimize.setAttribute('aria-expanded', String(expanded));

      current = warning ? null : state.cards?.[0];
      const answering = current?.status === 'answering';
      const failed = current?.status === 'error';
      const nextId = current?.questionId;
      const changedQuestion = nextId !== lastId;
      const follow = answering && !changedQuestion && body.scrollTop > 0
        && body.scrollHeight - body.scrollTop - body.clientHeight <= 12;
      status.classList.toggle('live', !warning);
      setText(status, warning ? 'Unavailable' : answering ? 'Answering…' : failed ? 'Error' : current ? 'Live' : 'Listening…');
      setText(question, current?.question?.text
        ? [current.question.speaker, current.question.ts && clock(current.question.ts), current.question.text].filter(Boolean).join(' · ')
        : '');
      question.hidden = !question.textContent;
      updateAnswer(String(current?.answer || '').trim().replace(/\*\*(.+?)\*\*/g, '$1'));
      answer.hidden = !lastAnswer;
      answer.classList.toggle('streaming', answering);
      setText(error, warning || (failed ? ERRORS[current.errorCode] || 'Something went wrong while answering.' : ''));
      error.hidden = !error.textContent;
      retry.hidden = !failed || ['ai_unavailable', 'route_not_found'].includes(current?.errorCode);
      if (answering || changedQuestion) retry.disabled = false;

      if (changedQuestion) body.scrollTop = 0;
      else if (follow) body.scrollTop = body.scrollHeight;
      lastId = nextId;
    };
  }


  function discard(mount) {
    mount.portal?.remove();
    mounts.delete(mount);
  }

  function render() {
    for (const m of [...mounts]) {
      if (!m.host.isConnected) { discard(m); continue; }
      if (m.kind === 'toggle') renderToggle(m.root); else m.update();
    }
  }

  // ---- mounting into the panel's placeholders ----
  function mount(host, kind) {
    if (host.shadowRoot || host.dataset.meetmemoMounted) return false;
    host.dataset.meetmemoMounted = '1';
    // Mount at the document root so transcript overflow cannot clip the moving card.
    const portal = kind === 'feed' ? el('div') : null;
    const surface = portal || host;
    surface.setAttribute('data-kind', kind);
    const root = surface.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = CSS;
    root.append(style);
    const update = portal ? mountOverlay(root, host) : null;
    if (portal) document.documentElement.append(portal);
    mounts.add({ host, kind, root, update, portal });
    return true;
  }

  let scanTimer = null;
  function scan() {
    scanTimer = null;
    if (dead) return;
    let mounted = false;
    for (const host of document.querySelectorAll(TOGGLE_SEL)) mounted = mount(host, 'toggle') || mounted;
    if (SHOW_OVERLAY) for (const host of document.querySelectorAll(FEED_SEL)) mounted = mount(host, 'feed') || mounted;
    for (const m of [...mounts]) if (!m.host.isConnected) discard(m);
    if (!mounts.size) return;
    watch();
    if (mounted) render();
  }
  const schedule = () => { if (!scanTimer) scanTimer = setTimeout(scan, 120); };

  function start() {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('resize', render);
    schedule();
    // Meet changes meetings without a page load: follow the URL.
    setInterval(() => {
      if (!mounts.size) return;
      const s = self.MEETMEMO_SYNC?.currentMeeting?.()?.sessionId;
      if (s && s !== watching) watch();
      else render();
    }, 2000);
  }

  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });
})();

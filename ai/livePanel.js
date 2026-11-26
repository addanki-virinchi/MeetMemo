// Claude panel for the live view (transcript.html?live=1): automatic, private answers to
// questions asked in the meeting.
//
// The panel only shows and controls; it never sends a question itself. The service worker
// (sync/live-worker.js) detects questions from live captions, asks the backend, and streams
// cards into chrome.storage.session; completed cards are also stored with the meeting on the
// backend (GET /v1/meetings/:id/ai/live), so a reload restores them without asking again.
//
// Auto-answer is per meeting and per account, off until the user turns it on here.
// Follows the page's identity: setUser() drops everything from the previous account, and every
// async step checks the generation it started in (same pattern as transcript.js).
const F = self.MeetMemoFormat;
const $ = (id) => document.getElementById(id);
const NARROW = '(max-width: 1080px)';
const AA_PREFIX = 'meetmemo_autoanswer:';
const LIVE_PREFIX = 'meetmemo_live:';
const CLAUDE_PREFIX = 'meetmemo_claude:';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const ERRORS = {
  ai_unavailable: "Claude isn't set up on the server right now.",
  ai_busy: 'Claude is busy. Try again in a minute.',
  ai_live_busy: 'Still answering earlier questions. Try again in a moment.',
  ai_rate_limited: 'Many questions were detected in a short time, so auto-answer paused for a few minutes.',
  ai_unreachable: "Couldn't reach Claude. Try again.",
  ai_timeout: 'Claude took too long to answer. Try again.',
  ai_declined: "Claude couldn't answer this one.",
  empty_answer: 'No answer came back. Try again.',
  stream_cut: 'The connection dropped before the answer finished.',
  stopped: 'Stopped before the answer finished.',
  network: "Can't reach the MeetMemo server. If it was idle it can take up to a minute to wake up.",
  route_not_found: "This MeetMemo server doesn't support live answers yet. Deploy the latest backend.",
  ai_failed: 'Something went wrong while answering. Try again.',
};

export function createLivePanel({ meetingId, api, lookup, onCite }) {
  const panel = $('live-panel');
  const list = $('live-cards');
  const status = $('live-status');
  const toggle = $('auto-answer');
  const tabs = document.querySelector('.view-tabs');
  const aiTab = tabs?.querySelector('[data-view="ai"]');
  if (aiTab) { aiTab.textContent = 'Claude'; aiTab.setAttribute('aria-controls', 'live-panel'); }
  $('ai-toggle')?.setAttribute('hidden', ''); // the Ask Meet Memo button is not part of the live workflow

  let user = null;
  let gen = 0;
  let loaded = false;
  let enabled = null; // server has AI configured (null = not known yet)
  let routeMissing = false;
  let autoOn = false;
  let serverCards = new Map(); // questionId -> card (completed, from the backend)
  let liveCards = new Map(); // questionId -> card (this device's worker, includes in-flight)
  let frame = 0;
  const copied = new Set();

  const aaKey = () => `${AA_PREFIX}${user.uid}:${meetingId}`;
  const liveKey = () => `${LIVE_PREFIX}${user.uid}:${meetingId}`;
  const claudeKey = () => `${CLAUDE_PREFIX}${user.uid}`;
  const narrow = () => matchMedia(NARROW).matches;

  function setView(view) {
    document.body.dataset.view = view;
    for (const b of document.querySelectorAll('.view-tabs [role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  }
  for (const b of document.querySelectorAll('.view-tabs [role="tab"]')) b.addEventListener('click', () => setView(b.dataset.view));

  // ---- data ----
  function cards() {
    const byId = new Map(serverCards);
    for (const [id, c] of liveCards) byId.set(id, { ...byId.get(id), ...c });
    return [...byId.values()]
      .filter((c) => c.status === 'answering' || c.status === 'answered' || (c.status === 'error' && c.shown !== false))
      .sort((a, b) => (b.question?.ts || 0) - (a.question?.ts || 0)); // newest first: the latest is always on top
  }

  function readLive(st) {
    if (!st || st.uid !== user?.uid || st.meetingId !== meetingId) { liveCards = new Map(); return; }
    liveCards = new Map(Object.entries(st.cards || {}));
  }

  async function load() {
    const myGen = gen;
    const store = await chrome.storage.local.get([aaKey(), claudeKey()]);
    const session = await chrome.storage.session.get(liveKey());
    if (myGen !== gen) return;
    // No choice for this meeting yet: the account-wide Claude switch decides (as in the worker).
    autoOn = !!(store[aaKey()] ?? store[claudeKey()])?.on;
    readLive(session[liveKey()]);
    render();
    try {
      const r = await api.listLiveCards(meetingId, { expectUid: user.uid });
      if (myGen !== gen) return;
      enabled = r.enabled;
      serverCards = new Map((r.cards || []).map((c) => [c.questionId, { ...c, shown: true }]));
    } catch (e) {
      if (myGen !== gen || e?.code === 'account_changed') return;
      if (e?.code === 'route_not_found') routeMissing = true;
      else console.warn('[MeetMemo] Could not load Claude cards', e?.message || e);
    }
    render();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (!user) return;
    if (area === 'session' && changes[liveKey()]) { readLive(changes[liveKey()].newValue); schedule(); }
    if (area === 'local' && changes[aaKey()]) { autoOn = !!changes[aaKey()].newValue?.on; schedule(); }
  });

  toggle.addEventListener('change', async () => {
    if (!user) return;
    const on = toggle.checked;
    autoOn = on;
    // `at` lets the worker ignore questions that were asked before Auto-answer was turned on.
    // Also the account-wide Claude switch (the one in the Meet panel), so both always agree.
    const at = Date.now();
    await chrome.storage.local.set({ [aaKey()]: { on, at }, [claudeKey()]: { on, at } });
    if (on) F.setPrefs({ liveAiIntroSeen: true });
    render();
  });

  // ---- rendering ----
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; render(); });
  }

  function timeChip(segmentId, fallbackTs) {
    const seg = lookup(segmentId);
    if (seg) {
      const chip = el('button', 'cite', seg.time);
      chip.type = 'button';
      chip.dataset.segmentId = segmentId;
      chip.title = `${seg.speaker}: ${seg.text}`;
      chip.setAttribute('aria-label', `Go to line at ${seg.time}`);
      return chip;
    }
    // Not saved/shown yet: a plain time, never a link to a line that may not exist.
    return fallbackTs ? el('span', 'time', F.time(new Date(fallbackTs))) : null;
  }

  function plainText(c) {
    const times = (c.sources || []).map((id) => lookup(id)?.time).filter(Boolean);
    return [
      `Q (${c.question?.speaker || 'Unknown speaker'}${c.question?.ts ? `, ${F.time(new Date(c.question.ts))}` : ''}): ${c.question?.text || ''}`,
      `A: ${String(c.answer || '').trim()}`,
      times.length ? `Sources: ${times.join(', ')}` : '',
    ].filter(Boolean).join('\n');
  }

  function renderCard(c) {
    const card = el('article', `live-card ${c.status}`);
    card.dataset.questionId = c.questionId;
    const head = el('header');
    const speaker = c.question?.speaker || 'Unknown speaker';
    head.append(el('span', 'avatar', F.initials(speaker)), el('span', 'name', speaker));
    const chip = timeChip(c.questionId, c.question?.ts);
    if (chip) head.append(chip);
    card.append(head, el('p', 'q', c.question?.text || ''));

    if (c.status === 'error') {
      const box = el('div', 'ai-error');
      box.setAttribute('role', 'alert');
      const text = el('div');
      text.append(el('strong', '', c.answer ? 'The answer was interrupted' : "Couldn't answer this question"), c.errorMessage && !ERRORS[c.errorCode] ? c.errorMessage : (ERRORS[c.errorCode] || ERRORS.ai_failed));
      box.append(text);
      if (!['ai_unavailable', 'route_not_found'].includes(c.errorCode)) {
        const row = el('div', 'row');
        const again = el('button', 'btn small', 'Retry');
        again.type = 'button';
        again.addEventListener('click', () => {
          again.disabled = true;
          chrome.runtime.sendMessage({ type: 'meetmemo-live-retry', meetingId, questionId: c.questionId, question: c.question }).catch(() => {});
        });
        row.append(again);
        box.append(row);
      }
      if (c.answer) card.append(answerBody(c, false));
      card.append(box);
      return card;
    }

    if (c.status === 'answering' && !c.answer) {
      const wait = el('div', 'status');
      const dots = el('span', 'dots');
      dots.append(el('i'), el('i'), el('i'));
      wait.append(dots, 'Answering…');
      card.append(wait);
      return card;
    }
    card.append(answerBody(c, c.status === 'answering'));
    if (c.status === 'answered') {
      const chips = (c.sources || []).map((id) => (lookup(id) ? timeChip(id) : null)).filter(Boolean);
      if (chips.length) {
        const src = el('div', 'sources');
        src.append(el('span', 'label', 'From'), ...chips);
        card.append(src);
      }
      const actions = el('div', 'ai-actions');
      const copy = el('button', 'btn ghost small', copied.has(c.questionId) ? 'Copied' : 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(plainText(c));
          copied.add(c.questionId);
          copy.textContent = 'Copied';
          setTimeout(() => { copied.delete(c.questionId); copy.textContent = 'Copy'; }, 1500);
        } catch { copy.textContent = 'Copy failed'; }
      });
      actions.append(copy);
      const t = c.timings;
      if (t?.settledAt && t?.firstTextAt) actions.append(el('span', 'meta', `first words in ${((t.firstTextAt - t.settledAt) / 1000).toFixed(1)} s`));
      card.append(actions);
    }
    return card;
  }

  function answerBody(c, streaming) {
    const body = el('div', 'answer');
    const blocks = String(c.answer || '').trim().split(/\n{2,}|\n(?=[-*•]\s)/).filter((b) => b.trim());
    blocks.forEach((b) => body.append(el('p', '', b.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\s*\n\s*/g, ' '))));
    if (streaming) (body.lastElementChild || body).append(el('span', 'caret'));
    return body;
  }

  function renderStatus() {
    status.replaceChildren();
    const unavailable = enabled === false || routeMissing;
    toggle.disabled = !user || unavailable;
    toggle.checked = autoOn && !unavailable;
    if (routeMissing) { status.append(el('p', 'off', ERRORS.route_not_found)); return; }
    if (enabled === false) { status.append(el('p', 'off', "Claude isn't set up on the MeetMemo server, so Auto-answer is unavailable. Your transcript is unaffected.")); return; }
    if (autoOn) {
      const p = el('p', 'listening');
      p.append(el('span', 'pulse'), 'Listening for questions…');
      status.append(p);
      return;
    }
    const intro = el('div', 'intro');
    intro.append(
      el('p', '', 'Turn on Auto-answer and Claude answers useful questions as they are asked in this meeting, here beside the transcript. Only you see the answers.'),
    );
    const privacy = el('p', 'ai-privacy');
    const link = el('a', '', 'How Claude uses your data');
    link.href = 'privacy.html#ai';
    link.target = '_blank';
    privacy.append("When a question is detected, it and a short excerpt of the last few transcript lines are sent to Anthropic's Claude to write the answer. ", link);
    intro.append(privacy);
    status.append(intro);
  }

  function render() {
    if (!user) return;
    renderStatus();
    const items = cards();
    const keep = list.scrollTop; // newest is on top; keep the reader's place when they scrolled down
    list.replaceChildren(...items.map(renderCard));
    if (!items.length && autoOn) list.append(el('p', 'empty-text', 'Answers to questions in this meeting will appear here.'));
    list.scrollTop = keep;
  }

  list.addEventListener('click', (e) => {
    const chip = e.target.closest('.cite');
    if (!chip) return;
    if (narrow()) setView('transcript');
    onCite(chip.dataset.segmentId);
  });

  return {
    setUser(next) {
      gen += 1;
      user = next;
      loaded = false;
      enabled = null;
      routeMissing = false;
      autoOn = false;
      serverCards = new Map();
      liveCards = new Map();
      list.replaceChildren();
      status.replaceChildren();
      panel.hidden = true;
      tabs?.setAttribute('hidden', '');
    },
    // A transcript for this user was rendered (first load or a live reload). loaded=false means
    // it was cleared (signed out, not found, deleted).
    transcriptReady(items, { loaded: ok = true, focus = false } = {}) {
      if (!user) return;
      if (!ok) {
        loaded = false;
        panel.hidden = true;
        tabs?.setAttribute('hidden', '');
        return;
      }
      const first = !loaded;
      loaded = true;
      panel.hidden = false;
      tabs?.removeAttribute('hidden');
      if (first) {
        if (focus && narrow()) setView('ai');
        load();
      } else {
        schedule(); // chips pick up newly saved lines
      }
    },
  };
}

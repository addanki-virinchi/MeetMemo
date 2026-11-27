// Ask Meet Memo panel for the transcript reader (transcript.html).
//
// Questions go to the MeetMemo backend, which answers with Claude from this meeting's saved
// transcript (backend/src/routes/aiRouter.js). The panel never talks to Anthropic directly and
// holds no keys. Answers cite transcript lines as [[cite:N]] markers; N indexes the answer's
// `citations` list of segment ids, shown here as time chips that jump to the line.
//
// Follows the page's identity: setUser() aborts any answer in progress and clears everything,
// and every async step checks the generation it started in (same pattern as transcript.js).
const F = self.MeetMemoFormat;
const $ = (id) => document.getElementById(id);
const NARROW = '(max-width: 1080px)';
const WAKE_HINT_MS = 5000;

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
  s.innerHTML = paths; // static markup only, never model or user text
  return s;
};
const ICON = {
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l.9-5.4A8 8 0 1 1 21 12Z"/><path d="M9 11h6M9 14h3.5"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>',
};

// Wording for every error code the backend or the network can produce.
const ERRORS = {
  ai_unavailable: ["Ask Meet Memo isn't available", "Ask Meet Memo isn't set up on the MeetMemo server right now."],
  ai_busy: ['Ask Meet Memo is busy', 'Too many people are asking right now. Try again in a minute.'],
  ai_unreachable: ["Couldn't reach Ask Meet Memo", 'Try again in a moment.'],
  ai_declined: ["Couldn't answer this question", 'Try asking it a different way.'],
  empty_answer: ['No answer came back', 'Try again or rephrase the question.'],
  ai_failed: ['Something went wrong', 'The answer could not be finished. Try again.'],
  ai_rate_limited: ['Question limit reached', "You've asked a lot of questions in a short time. Try again in a few minutes."],
  no_transcript: ['Nothing to ask about yet', 'This meeting has no saved lines yet.'],
  transcript_too_long: ['Transcript too long', 'This transcript is too long for Ask Meet Memo.'],
  not_found: ['Meeting not found', 'This meeting was deleted or belongs to another account.'],
  route_not_found: ['Ask Meet Memo not available on this server', "The MeetMemo server you're connected to doesn't have Ask Meet Memo yet. Deploy the latest backend, then try again."],
  thread_not_found: ['Conversation not found', 'It may have been deleted. Your question will start a new conversation.'],
  unauthenticated: ['Signed out', 'Sign in from the MeetMemo popup, then ask again.'],
  network: ["Can't reach the MeetMemo server", 'If it was idle it can take up to a minute to wake up. Try again shortly.'],
  stream_cut: ['The answer was cut off', 'The connection dropped before the answer finished. Try again.'],
  stopped: ['Stopped', 'You stopped this answer before it started. Try again when you are ready.'],
};
const errorFor = (code) => ERRORS[code] || ERRORS.ai_failed;

function codeOf(e) {
  if (e?.code) return e.code;
  if (e instanceof TypeError || e?.name === 'TimeoutError') return 'network';
  if (e?.status >= 500) return 'ai_failed';
  return 'ai_failed';
}

// ---- Answer formatting: paragraphs, "- " / "1. " lists, **bold**, citation chips. DOM only. ----
function renderInline(parent, text, msg, ctx) {
  const re = /\*\*(.+?)\*\*|\[\[cite:(\d+)\]\]/g;
  let i = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > i) parent.append(text.slice(i, m.index));
    if (m[1] !== undefined) {
      const strong = el('strong');
      renderInline(strong, m[1], msg, ctx);
      parent.append(strong);
    } else {
      const segId = msg.citations?.[Number(m[2])];
      const seg = segId ? ctx.lookup(segId) : null;
      if (seg) {
        const chip = el('button', 'cite', seg.time);
        chip.type = 'button';
        chip.dataset.segmentId = segId;
        chip.title = `${seg.speaker}: ${seg.text}`;
        chip.setAttribute('aria-label', `Go to line at ${seg.time}`);
        parent.append(chip);
      }
    }
    i = re.lastIndex;
  }
  if (i < text.length) parent.append(text.slice(i));
}

function formatAnswer(msg, ctx, streaming) {
  let text = String(msg.text || '').trim();
  if (streaming && (text.match(/\*\*/g) || []).length % 2) text += '**';
  const root = el('div', 'answer');
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    const bullet = lines.every((l) => /^\s*[-*•]\s+/.test(l));
    const numbered = !bullet && lines.every((l) => /^\s*\d+[.)]\s+/.test(l));
    if (bullet || numbered) {
      const list = el(numbered ? 'ol' : 'ul');
      for (const l of lines) {
        const li = el('li');
        renderInline(li, l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''), msg, ctx);
        list.append(li);
      }
      root.append(list);
    } else {
      // Mixed blocks: a lead-in line followed by bullets.
      const p = el('p');
      let list = null;
      for (const l of lines) {
        if (/^\s*[-*•]\s+/.test(l)) {
          if (!list) { list = el('ul'); }
          const li = el('li');
          renderInline(li, l.replace(/^\s*[-*•]\s+/, ''), msg, ctx);
          list.append(li);
        } else {
          if (p.childNodes.length) p.append(el('br'));
          renderInline(p, l, msg, ctx);
        }
      }
      if (p.childNodes.length) root.append(p);
      if (list) root.append(list);
    }
  }
  if (streaming) {
    const last = root.lastElementChild;
    const target = last && (last.tagName === 'UL' || last.tagName === 'OL') ? last.lastElementChild : last;
    (target || root).append(el('span', 'caret'));
  }
  return root;
}

function plainText(msg, ctx) {
  return String(msg.text || '').replace(/\[\[cite:(\d+)\]\]/g, (_, i) => {
    const seg = ctx.lookup(msg.citations?.[Number(i)]);
    return seg ? `[${seg.time}]` : '';
  }).replace(/\*\*(.+?)\*\*/g, '$1').trim();
}

export function createAskPanel({ api, meetingId, live = false, lookup, onCite }) {
  const panel = $('ai-panel');
  const thread = $('ai-thread');
  const input = $('ai-question');
  const send = $('ai-send');
  const toggle = $('ai-toggle');
  const ctx = { lookup: (id) => (id ? lookup(id) : null) };

  let user = null;
  let gen = 0;
  let ready = false; // a transcript is loaded for the signed-in user
  let enabled = null; // server has AI configured (null = not known yet)
  let threadId = null;
  let messages = []; // { id?, role, text, citations, status, errorCode, saved, pending, wakeHint, lineCountAtAsk }
  let running = null; // { controller, answer }
  let historyLoaded = false;
  let speakers = [];
  let lineCount = 0;

  // ---- open / close / narrow tabs ----
  const narrow = () => matchMedia(NARROW).matches;
  function setOpen(open, { save = true } = {}) {
    document.body.classList.toggle('panel-closed', !open);
    toggle.setAttribute('aria-pressed', String(open));
    if (save) F.setPrefs({ aiPanelOpen: open });
  }
  function setView(view) {
    document.body.dataset.view = view;
    for (const b of document.querySelectorAll('.view-tabs [role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  }
  toggle.addEventListener('click', () => {
    const open = document.body.classList.contains('panel-closed');
    setOpen(open);
    if (open) input.focus();
  });
  $('ai-close').addEventListener('click', () => (narrow() ? setView('transcript') : setOpen(false)));
  for (const b of document.querySelectorAll('.view-tabs [role="tab"]')) {
    b.addEventListener('click', () => {
      setOpen(true, { save: false });
      setView(b.dataset.view);
      if (b.dataset.view === 'ai') input.focus();
    });
  }
  $('ai-new').addEventListener('click', () => {
    stop();
    threadId = null;
    messages = [];
    render();
    input.focus();
  });

  // ---- rendering ----
  function who(note) {
    const w = el('div', 'who');
    const mark = el('span', 'ai-mark');
    mark.append(svg(ICON.chat));
    w.append(mark, 'Ask Meet Memo');
    if (note) w.append(el('span', 'note', `· ${note}`));
    return w;
  }

  function suggestions() {
    const named = speakers.find((s) => s && s !== 'Unknown speaker');
    return [
      'What decisions were made in this meeting?',
      'List the action items and who owns each one',
      'Summarize this meeting in a few sentences',
      named ? `What did ${named} say?` : 'What questions were left open?',
    ];
  }

  function renderEmpty() {
    const box = el('div', 'ai-empty');
    if (enabled === false) {
      box.append(el('h3', '', "Ask Meet Memo isn't available"), el('p', '', "It isn't set up on the MeetMemo server right now. Your transcript is unaffected."));
      thread.append(box);
      return;
    }
    box.append(
      el('h3', '', 'Ask anything about this meeting'),
      el('p', '', 'Ask Meet Memo reads this transcript and answers with links to the lines it used. It only knows what was said in this meeting.'),
      el('p', 'label', 'Try asking'),
    );
    const list = el('div', 'suggest');
    for (const q of suggestions()) {
      const b = el('button', '', q);
      b.type = 'button';
      b.addEventListener('click', () => ask(q));
      list.append(b);
    }
    const privacy = el('p', 'ai-privacy');
    const link = el('a', '', 'How Ask Meet Memo uses your data');
    link.href = 'privacy.html#ai';
    link.target = '_blank';
    privacy.append("Your question and this meeting's transcript are sent to Anthropic's Claude to write the answer. ", link);
    box.append(list, privacy);
    thread.append(box);
  }

  function renderError(msg, isLast, codeOverride = null) {
    const code = codeOverride || msg.errorCode;
    const [title, detail] = !codeOverride && msg.errorMessage ? [errorFor(code)[0], msg.errorMessage] : errorFor(code);
    const box = el('div', 'ai-error');
    box.setAttribute('role', 'alert');
    const text = el('div');
    text.append(el('strong', '', title), detail);
    box.append(text);
    const retryable = !['ai_unavailable', 'no_transcript', 'transcript_too_long', 'not_found', 'route_not_found', 'unauthenticated'].includes(code);
    if (isLast && retryable) {
      const row = el('div', 'row');
      const again = el('button', 'btn small', 'Try again');
      again.type = 'button';
      again.addEventListener('click', () => retry(msg));
      row.append(again);
      box.append(row);
    }
    return box;
  }

  function renderAnswer(msg, isLast) {
    const box = el('div', 'msg ai');
    if (msg.pending) {
      box.classList.add('thinking');
      box.append(who());
      const status = el('div', 'status');
      const dots = el('span', 'dots');
      dots.append(el('i'), el('i'), el('i'));
      status.append(dots, msg.wakeHint ? 'Waking up the server…' : 'Reading the transcript…');
      box.append(status);
      for (const w of ['92%', '78%', '85%']) { const s = el('span', 'skeleton'); s.style.width = w; box.append(s); }
      return box;
    }
    if (msg.status === 'error') return renderError(msg, isLast);
    if (msg.status === 'stopped' && !String(msg.text || '').trim()) return renderError(msg, isLast, 'stopped');
    const streaming = msg.status === 'streaming';
    const note = live && msg.lineCountAtAsk && !streaming ? `based on ${msg.lineCountAtAsk} line${msg.lineCountAtAsk === 1 ? '' : 's'} saved so far` : '';
    box.append(who(note), formatAnswer(msg, ctx, streaming));
    if (msg.status === 'stopped') box.append(el('p', 'ai-flag', 'Stopped. Ask again to get the full answer.'));
    if (msg.status === 'cut_short') box.append(el('p', 'ai-flag', 'This answer was cut short. Ask for the rest, or ask a narrower question.'));
    if (!streaming) {
      const actions = el('div', 'ai-actions');
      const copy = el('button', 'btn ghost small', 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(plainText(msg, ctx)); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy failed'; }
        setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
      });
      actions.append(copy);
      if (isLast) {
        const again = el('button', 'btn ghost small', 'Try again');
        again.type = 'button';
        again.addEventListener('click', () => retry(msg));
        actions.append(again);
      }
      const cited = new Set((msg.citations || []).filter((id) => ctx.lookup(id))).size;
      if (cited) actions.append(el('span', 'meta', `${cited} line${cited === 1 ? '' : 's'} cited`));
      box.append(actions);
    }
    return box;
  }

  function render() {
    const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
    thread.replaceChildren();
    if (!messages.length) renderEmpty();
    messages.forEach((m, i) => {
      if (m.role === 'user') thread.append(el('div', 'msg user', m.text));
      else thread.append(renderAnswer(m, i === messages.length - 1));
    });
    if (atBottom || running) thread.scrollTop = thread.scrollHeight;
    syncComposer();
  }

  function syncComposer() {
    const busy = !!running;
    const blocked = !ready || enabled === false;
    send.classList.toggle('stop', busy);
    send.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    send.title = busy ? 'Stop' : 'Send';
    send.replaceChildren(svg(busy ? ICON.stop : ICON.send));
    send.disabled = !busy && (blocked || !input.value.trim());
    input.disabled = blocked;
    input.placeholder = enabled === false ? 'Ask Meet Memo is not available' : 'Ask about this meeting…';
  }

  // ---- asking ----
  function stop() {
    running?.controller.abort();
  }

  async function run(body, answer) {
    const myGen = gen;
    const controller = new AbortController();
    running = { controller, answer };
    const wake = setTimeout(() => { if (answer.pending && myGen === gen) { answer.wakeHint = true; render(); } }, WAKE_HINT_MS);
    const question = messages[messages.indexOf(answer) - 1];
    try {
      const prefs = await F.getPrefs();
      await api.askMeeting(meetingId, {
        ...body,
        ...(prefs.aiLanguage ? { answerLanguage: prefs.aiLanguage } : {}),
        ...(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].includes(prefs.aiModel) ? { model: prefs.aiModel } : {}),
        ...(['low', 'medium', 'high'].includes(prefs.aiEffort) ? { effort: prefs.aiEffort } : {}),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, {
        expectUid: user.uid,
        signal: controller.signal,
        onEvent(event, data) {
          if (myGen !== gen) return;
          if (event === 'meta') {
            threadId = data.threadId;
            if (question) { question.id = data.questionId; question.saved = true; }
            answer.id = data.answerId;
            answer.lineCountAtAsk = data.lineCount;
          } else if (event === 'cite') {
            answer.citations[data.index] = data.segmentId;
          } else if (event === 'delta') {
            answer.pending = false;
            answer.status = 'streaming';
            answer.text += data.text;
          } else if (event === 'done') {
            answer.pending = false;
            answer.status = data.status || 'complete';
          } else if (event === 'error') {
            Object.assign(answer, { pending: false, status: 'error', errorCode: data.code, errorMessage: data.message, text: '' });
          }
          render();
        },
      });
    } catch (e) {
      if (myGen !== gen || e?.code === 'account_changed') return;
      answer.pending = false;
      if (controller.signal.aborted) {
        answer.status = answer.text ? 'stopped' : 'error';
        if (!answer.text) { answer.errorCode = 'stopped'; answer.errorMessage = null; }
      } else {
        const code = codeOf(e);
        if (code === 'thread_not_found') threadId = null;
        Object.assign(answer, { status: 'error', errorCode: code, errorMessage: ERRORS[code] ? null : e?.message || null });
      }
    } finally {
      clearTimeout(wake);
      if (myGen === gen) {
        running = null;
        render();
      }
    }
  }

  function ask(text) {
    const question = String(text || '').trim();
    if (!question || running || !ready || enabled === false) return;
    if (narrow()) setView('ai');
    input.value = '';
    autosize();
    const answer = { role: 'assistant', text: '', citations: [], status: 'pending', pending: true };
    messages.push({ role: 'user', text: question, saved: false }, answer);
    render();
    run({ question, ...(threadId ? { threadId } : {}) }, answer);
  }

  // Try again: replaces the last answer. If the question never reached the server, re-send it.
  function retry(msg) {
    if (running) return;
    const i = messages.indexOf(msg);
    const question = messages[i - 1];
    if (!question || question.role !== 'user') return;
    const answer = { role: 'assistant', text: '', citations: [], status: 'pending', pending: true };
    messages[i] = answer;
    render();
    if (question.saved && threadId) run({ threadId, regenerate: true }, answer);
    else run({ question: question.text, ...(threadId ? { threadId } : {}) }, answer);
  }

  // ---- composer ----
  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }
  input.addEventListener('input', () => { autosize(); syncComposer(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); }
  });
  $('ai-composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (running) stop(); else ask(input.value);
  });

  // ---- citations ----
  thread.addEventListener('click', (e) => {
    const chip = e.target.closest('.cite');
    if (!chip) return;
    if (narrow()) setView('transcript');
    onCite(chip.dataset.segmentId);
  });

  // ---- history ----
  async function loadHistory() {
    const myGen = gen;
    try {
      const list = await api.listAiThreads(meetingId, { expectUid: user.uid });
      if (myGen !== gen) return;
      enabled = list.enabled;
      historyLoaded = true;
      const latest = list.items?.[0];
      if (latest && !messages.length) {
        const t = await api.getAiThread(meetingId, latest.id, { expectUid: user.uid });
        if (myGen !== gen || messages.length) return;
        threadId = t.id;
        messages = t.messages.map((m) => ({ ...m, saved: true, citations: m.citations || [] }));
      }
    } catch (e) {
      if (myGen !== gen) return;
      if (e?.status === 404) enabled = enabled ?? true;
      // History is optional: asking still works, so only log.
      console.warn('[MeetMemo] Could not load Ask Meet Memo history', e?.message || e);
    }
    render();
  }

  // ---- page hooks ----
  return {
    // Identity changed (sign-in, sign-out, account switch): drop everything from the old one.
    setUser(next) {
      gen += 1;
      running?.controller.abort();
      running = null;
      user = next;
      ready = false;
      historyLoaded = false;
      enabled = null;
      threadId = null;
      messages = [];
      panel.hidden = true;
      toggle.hidden = true;
      document.querySelector('.view-tabs')?.setAttribute('hidden', '');
      render();
    },
    // A transcript for this user was rendered (first load or a live reload).
    async transcriptReady(items, { focus = false } = {}) {
      if (!user) return;
      const counts = new Map();
      for (const s of items) counts.set(s.speaker || 'Unknown speaker', (counts.get(s.speaker || 'Unknown speaker') || 0) + 1);
      speakers = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
      lineCount = items.length;
      const first = !ready;
      ready = lineCount > 0;
      panel.hidden = !ready;
      toggle.hidden = !ready;
      document.querySelector('.view-tabs')?.toggleAttribute('hidden', !ready);
      if (!ready) return;
      if (first) {
        const prefs = await F.getPrefs();
        setOpen(focus || prefs.aiPanelOpen !== false, { save: false });
        if (focus) {
          setView('ai');
          setTimeout(() => input.focus(), 0);
        }
        if (!historyLoaded) loadHistory();
      }
      render(); // chips pick up new or changed lines
    },
  };
}

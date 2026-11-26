// Live question detection for auto-answer (classic script; loaded before sync/content.js in
// the Meet tab, and by tests).
//
// Live caption revisions go in through observe(); settled, plausible questions come out through
// onCandidate. Nothing here talks to the network: the service worker decides whether
// Auto-answer is on for this meeting and owns every request (sync/live-worker.js).
//
// Settling: Meet has no "final caption" flag, so an utterance (adjacent fragments from the same
// speaker) is settled when another speaker starts talking, a message carries a final flag, or
// after a quiet window with no revisions (QUIET_MS, reset on every revision). An utterance that
// ends mid-phrase ("…affect the") gets one extra wait before it is considered.
//
// Prefilter: a cheap local check drops greetings, audio/video checks and obvious small talk, and
// keeps anything that reads like a question even without caption punctuation. The model makes
// the real decision (SKIP/ANSWER) on the backend.
(() => {
  const QUIET_MS = 750; // initial quiet window (600–900 ms)
  const INCOMPLETE_EXTRA_MS = 1800; // extra wait for an utterance that ends mid-phrase
  const MAX_RECENT = 40;
  const CONTEXT_LINES = 12;
  const MAX_TAIL_WORDS = 60; // a long caption keeps only its end as the candidate text
  const MAX_FRAGMENT_GAP_MS = 20_000;
  const GROWTH_WORDS = 3;

  const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}'?\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = (s) => norm(s).replace(/\?/g, ' ').split(' ').filter(Boolean);

  // Whole-clause small talk and connection checks. Matched against each clause on its own, so
  // "can you hear me ok so how would this affect churn" still keeps the second question.
  const SMALL_TALK = [
    /^(hi|hey|hello|hiya|yo|good (morning|afternoon|evening)|morning|welcome)( (all|everyone|everybody|folks|guys|team|there))?$/,
    /^(can|could|do) (you|everyone|everybody|anyone|u|y'all|you all|you guys) (hear|see) (me|us|my (screen|video|camera|slides?))( (ok|okay|now|alright|all right|well|fine))?$/,
    /^(is|are) (my|the) (audio|mic|microphone|video|camera|screen|sound|connection)( (ok|okay|working|coming through|clear|fine|good))?$/,
    /^(am i|are you|is it) (on mute|muted|unmuted|audible|frozen|breaking up|lagging|cutting out|there|back)$/,
    /^(you|u) (still )?there$/,
    /^did (i|you|we) (lose|drop) (you|me|us|the call|connection)$/,
    /^how (are|r) (you|u|things|everyone|everybody|you all|y'all|you guys|we)( doing| today)?$/,
    /^how('s| is| has| was) (it going|everyone|everybody|your (day|week|weekend|morning|evening|holiday|trip|vacation)|the (weekend|holiday|trip|vacation))( been)?( going)?$/,
    /^how (was|is) (your|the) (day|week|weekend|morning|evening|holiday|holidays|trip|vacation|flight)$/,
    /^(what's|whats|what is) up$/,
    /^(how about you|and you|you)$/,
    /^(can|shall) (we|i) (start|begin|get started)$/,
    /^(ready|everyone ready|are we ready|are you ready)$/,
  ];

  const WH = 'what|what\'s|whats|how|why|when|where|who|whom|whose|which';
  const AUX = 'can|could|should|would|will|shall|is|are|was|were|do|does|did|have|has|may|might|must|isn\'t|aren\'t|don\'t|doesn\'t|didn\'t|won\'t|wouldn\'t|shouldn\'t|can\'t|couldn\'t';
  const LEAD = '(?:so|and|but|okay|ok|right|um|uh|well|then|also|now|just|quick question|one question|question)';
  const ASKING = new RegExp(`(?:^|[?.!]\\s*|\\b${LEAD}\\s+)(?:${WH}|${AUX})\\b`);
  const PHRASES = /\b(explain|define|definition of|describe|tell me|walk (me|us) through|any (idea|ideas|thoughts)|thoughts on|what do you think|do you know|i wonder|i'm wondering|curious (about|whether|if)|difference between|pros and cons|trade ?offs?|is there a way|how come|what if|what about|how about)\b/;
  // Ends mid-phrase: a function word or a trailing comma means more is probably coming.
  const DANGLING = /(?:,|\b(the|a|an|of|to|for|with|and|or|but|about|in|on|at|is|are|was|our|your|my|their|his|her|its|this|that|these|those|what|how|which|if|because|so|like|from|by|into|than|then|as|we|i|it's|whether|between|um|uh))$/;

  function clauses(text) {
    return String(text || '').split(/(?<=[?.!])\s+|\s*\b(?=(?:so|okay|ok|anyway|alright|all right)\s+(?:what|how|why|when|where|who|which|can|could|should|would|is|are|do|does|did)\b)/i).map(norm).filter(Boolean);
  }

  // A greeting in front of something else ("hi, how would we…") is dropped before checking.
  const GREETING = /^(hi|hey|hello|hiya|good (morning|afternoon|evening))( (all|everyone|everybody|folks|guys|team|there))?\s+(?=\S)/;

  // 'small-talk' | 'statement' | 'too-short' | 'question'
  function classify(text) {
    const parts = clauses(text);
    const substantive = parts.map((c) => c.replace(GREETING, '')).filter((c) => !SMALL_TALK.some((re) => re.test(c.replace(/\?/g, '').trim())));
    if (!substantive.length) return parts.length ? 'small-talk' : 'too-short';
    const rest = substantive.join(' ? ');
    if (words(rest).length < 3) return 'too-short';
    if (/\?/.test(rest) || ASKING.test(rest) || PHRASES.test(rest)) return 'question';
    return 'statement';
  }

  const looksIncomplete = (text) => DANGLING.test(String(text || '').trim().toLowerCase().replace(/[^\p{L}\p{N}',\s]/gu, '').trim());

  function tail(text) {
    const w = String(text || '').trim().split(/\s+/);
    return w.length > MAX_TAIL_WORDS ? w.slice(-MAX_TAIL_WORDS).join(' ') : w.join(' ');
  }

  function createDetector({
    onCandidate, now = () => Date.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t),
    quietMs = QUIET_MS, incompleteExtraMs = INCOMPLETE_EXTRA_MS, isPaused = () => false,
  }) {
    const recent = new Map(); // sourceId -> { sourceId, speaker, text, ts }, first-seen order
    const emitted = new Map(); // question sourceId -> word count when last emitted
    let open = null; // { speaker, ids: [sourceId], timer, extended }

    const cap = () => { while (recent.size > MAX_RECENT) recent.delete(recent.keys().next().value); };

    function settle(u) {
      if (!u || u !== open) return;
      clearTimer(u.timer);
      open = null;
      if (isPaused()) return;
      const frags = u.ids.map((id) => recent.get(id)).filter(Boolean);
      if (!frags.length) return;
      const last = frags[frags.length - 1];
      const text = tail(frags.map((f) => f.text).join(' '));
      // Fragment boundaries count as clause breaks ("so given all that" + "how would…"), and the
      // newest fragment must not be small talk on its own.
      if (classify(tail(frags.map((f) => f.text).join('. '))) !== 'question' || classify(tail(last.text)) === 'small-talk') return;
      const n = words(text).length;
      const prev = emitted.get(last.sourceId);
      if (prev !== undefined && n < prev + GROWTH_WORDS) return; // same caption, not grown enough
      emitted.set(last.sourceId, n);
      while (emitted.size > MAX_RECENT * 4) emitted.delete(emitted.keys().next().value);
      const all = [...recent.values()];
      const at = all.indexOf(last);
      const context = all.slice(Math.max(0, at - (CONTEXT_LINES - 1)), at + 1)
        .map((l) => ({ sourceId: l.sourceId, ...(l.speaker ? { speaker: l.speaker } : {}), ts: l.ts, text: l.text }));
      onCandidate({ sourceId: last.sourceId, speaker: last.speaker, ts: last.ts, text, context, settledAt: now() });
    }

    function arm(u, ms) {
      clearTimer(u.timer);
      u.timer = setTimer(() => {
        if (u !== open) return;
        const text = u.ids.map((id) => recent.get(id)?.text || '').join(' ');
        if (!u.extended && looksIncomplete(text)) { u.extended = true; arm(u, incompleteExtraMs); return; }
        settle(u);
      }, ms);
    }

    return {
      // One accepted caption revision. history: true for lines replayed on (re)connect; they
      // are kept as context but never start a candidate.
      observe({ sourceId, speaker, text, ts, final = false, history = false }) {
        if (!sourceId || !String(text || '').trim()) return;
        const key = String(sourceId);
        const prevLine = recent.get(key);
        recent.set(key, { sourceId: key, speaker: speaker || prevLine?.speaker || '', text: String(text), ts: prevLine?.ts ?? ts ?? now() });
        cap();
        if (history) return;
        const who = speaker || prevLine?.speaker || '';
        if (open && open.ids.includes(key)) {
          // A revision of the open utterance: wait again (and allow one more extension).
          open.extended = false;
        } else if (open && open.speaker === who && now() - (recent.get(open.ids.at(-1))?.ts ?? 0) < MAX_FRAGMENT_GAP_MS) {
          open.ids.push(key); // adjacent fragment from the same speaker
        } else {
          if (open) settle(open); // another speaker started: the previous utterance is done
          open = { speaker: who, ids: [key], timer: null, extended: false };
        }
        if (final) { settle(open); return; }
        arm(open, quietMs);
      },
      // Captions paused, meeting changed, or the tab is going away: drop pending work.
      reset() {
        if (open) clearTimer(open.timer);
        open = null;
        recent.clear();
      },
    };
  }

  self.MeetMemoLiveDetect = { createDetector, classify, looksIncomplete, QUIET_MS };
})();

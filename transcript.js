// Read-only, private transcript reader for a meeting saved by the sync layer.
//
// - Loads every page of segments (the backend pages by (ts, id)); the line count, Copy and
//   Download cover the whole meeting, and a partial load is labelled as such.
// - Follows the local session: on sign-out or an account switch the rendered text and the
//   copy buffer are cleared, in-flight loads are discarded, and a new account must be
//   authorized by the backend (ownership check) before anything is shown again.
// - With ?live=1 (opened from the meeting panel) it follows that meeting's save status and
//   reloads as queued lines reach the backend.
// - "Read in" translates the saved text for reading only, on this device, with Chrome's
//   built-in Translator (when the browser has it). The saved transcript is never changed and
//   no text is sent to the MeetMemo server or any other service for translation.
//
// - Beside the transcript: in the live view (?live=1) the MeetMemo AI panel (ai/livePanel.js)
//   with automatic answers to questions asked in the meeting; for a saved meeting, Ask MeetMemo AI
//   (ai/askPanel.js). This file only tells the panel who is signed in and when a transcript is
//   shown, and scrolls to a line when an answer cites it.
import { createAuthProvider, createClient } from './extension-auth/index.js';
import { createAskPanel } from './ai/askPanel.js';
import { createLivePanel } from './ai/livePanel.js';

const { STATUS_KEY, statusFor } = self.MeetMemoSession;
const F = self.MeetMemoFormat;
const auth = createAuthProvider();
const api = createClient(auth);
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const meetingId = params.get('id');
const live = params.get('live') === '1';
let askFocus = params.get('ask') === '1'; // opened from an "Ask AI" button: open the panel once

// Rendered lines by segment id, for the citation chips in AI answers.
const segIndex = new Map(); // id -> { row, time, speaker, text }

function highlightSegment(segmentId) {
  const row = segIndex.get(segmentId)?.row;
  if (!row) return;
  row.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  row.classList.remove('cited');
  void row.offsetWidth; // restart the highlight if the same line is cited twice in a row
  row.classList.add('cited');
  setTimeout(() => row.classList.remove('cited'), 2400);
}

const lookup = (id) => segIndex.get(id) || null;
const askPanel = meetingId && !live ? createAskPanel({ api, meetingId, live, lookup, onCite: highlightSegment }) : null;
const livePanel = meetingId && live ? createLivePanel({ api, meetingId, lookup, onCite: highlightSegment }) : null;

let currentUser = null;
let gen = 0; // identity/load generation; stale loads compare against it
let lines = []; // copy buffer for the currently rendered transcript (original text)
let lastSavedAt = null;
let reloadTimer = null;

// Rendered state used by Download and translation.
let shown = null; // { meeting, items, textEls, complete }
let sourceLang = null; // detected language of the saved text
let viewLang = ''; // '' = original
const translations = new Map(); // lang -> Map(original text -> translated text); survives live reloads
let translateRun = 0;

const translatorApi = () => (typeof self.Translator === 'function' || typeof self.Translator === 'object' ? self.Translator : null);

function setError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}

function setNotice(message) {
  $('notice').textContent = message || '';
  $('notice').hidden = !message;
}

function setTranslateStatus(message) {
  const s = $('translate-status');
  if (s) s.textContent = message || '';
}

function setExportVisible(visible) {
  $('copy').hidden = !visible;
  for (const id of ['download', 'print']) if ($(id)) $(id).hidden = !visible;
}

function clearTranscript(title = 'Transcript') {
  lines = [];
  shown = null;
  sourceLang = null;
  viewLang = '';
  translations.clear();
  translateRun += 1;
  segIndex.clear();
  askPanel?.transcriptReady([]); // hides the panel until a transcript is shown again (keeps the conversation)
  livePanel?.transcriptReady([], { loaded: false });
  $('segments').replaceChildren();
  $('segments').className = '';
  setExportVisible(false);
  $('copy').textContent = 'Copy text';
  $('title').textContent = title;
  $('meta').textContent = '';
  if ($('platform')) $('platform').textContent = '';
  if ($('translate-box')) $('translate-box').hidden = true;
  setTranslateStatus('');
  document.title = 'Transcript · MeetMemo';
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function lineFor(s, text) {
  return `[${new Date(s.ts).toLocaleTimeString()}] ${s.speaker || 'Unknown speaker'}: ${text}`;
}

function renderMeta(meeting, items, complete) {
  const heading = F.meetingHeading(meeting);
  const created = F.toDate(meeting.createdAt);
  document.title = `${heading.title} · MeetMemo`;
  $('title').textContent = heading.title;
  if ($('platform')) $('platform').textContent = heading.isCustom && heading.code ? `${heading.platform} · ${heading.code}` : heading.platform;
  const first = items[0]?.ts;
  const last = items[items.length - 1]?.ts;
  const speakers = new Set(items.map((s) => s.speaker || 'Unknown speaker')).size;
  const count = `${items.length} line${items.length === 1 ? '' : 's'}${complete ? '' : ' (incomplete)'}`;
  const parts = [
    created ? `${F.longDate(created)}, ${F.time(created)}` : null,
    first && last && last - first > 60000 ? F.duration(last - first) : null,
    items.length ? `${speakers} speaker${speakers === 1 ? '' : 's'}` : null,
    count,
  ].filter(Boolean);
  const meta = $('meta');
  meta.replaceChildren();
  for (const p of parts) meta.append(el('span', '', p));
  meta.append(el('span', 'private', 'Private: visible only to your account'));
}

function renderSegments(meeting, items, complete) {
  renderMeta(meeting, items, complete);
  const out = [];
  const textEls = [];
  const frag = document.createDocumentFragment();
  let prev = null;
  segIndex.clear();
  const slots = new Map(); // speaker -> colour slot, in order of first appearance (6 distinct)
  for (const s of items) {
    const speakerName = s.speaker || 'Unknown speaker';
    if (!slots.has(speakerName)) slots.set(speakerName, slots.size % 6);
    const cont = prev && (prev.speaker || 'Unknown speaker') === speakerName && s.ts - prev.ts < 120000;
    const row = el('div', `segment sp${slots.get(speakerName)}${cont ? ' cont' : ''}`);
    const time = new Date(s.ts).toLocaleTimeString();
    const timeEl = el('div', 'time', F.clock(new Date(s.ts)) || time);
    const body = el('div', 'body');
    const speaker = el('div', 'speaker');
    speaker.append(el('span', 'avatar', F.initials(speakerName)), el('span', 'name', speakerName));
    const text = el('div', 'text', s.text);
    body.append(speaker, text);
    row.append(timeEl, body);
    segIndex.set(s.id, { row, time: F.time(new Date(s.ts)), speaker: speakerName, text: s.text });
    frag.append(row);
    textEls.push(text);
    out.push(`[${time}] ${speakerName}: ${s.text}`);
    prev = s;
  }
  $('segments').className = '';
  $('segments').replaceChildren(frag);
  if (!items.length) {
    $('segments').className = 'empty-text';
    $('segments').textContent = live ? 'No lines saved yet. New lines appear here as they are saved.' : 'No lines saved yet.';
  }
  lines = complete ? out : [];
  shown = { meeting, items, textEls, complete };
  setExportVisible(complete && items.length > 0); // never copy a partial transcript as if it were whole
  askPanel?.transcriptReady(items, { focus: askFocus });
  livePanel?.transcriptReady(items, { loaded: true, focus: askFocus });
  if (items.length || live) askFocus = false;
  // Live reloads keep the reader's chosen language.
  setupTranslation(items).then(() => { if (viewLang) applyLanguage(viewLang, { quiet: true }); });
}

function explain(e) {
  if (e.code === 'unauthenticated') return 'Sign in from the MeetMemo popup to view this transcript.';
  if (e.status === 404) return 'Meeting not found for this account.';
  if (e instanceof TypeError || e?.name === 'TimeoutError') return "Can't reach the MeetMemo server. If it was idle it may take up to a minute to wake up; try again shortly.";
  return e.message || 'Could not load the transcript.';
}

async function load() {
  const myGen = ++gen;
  const user = currentUser;
  if (!user) return;
  setError(null);
  const stale = () => myGen !== gen; // identity changes and newer loads both bump gen
  try {
    if (!shown) $('meta').textContent = 'Loading…';
    const meeting = await api.getMeeting(meetingId, { expectUid: user.uid }); // backend ownership check
    if (stale()) return;
    const { items, complete } = await api.listAllSegments(meetingId, {
      expectUid: user.uid,
      onPage: (sofar) => { if (!stale() && !shown) $('meta').textContent = `Loading… ${sofar.length} lines`; },
    });
    if (stale()) return;
    renderSegments(meeting, items, complete);
    if (!complete) setError('This transcript is too long to load completely here; only the first part is shown and Copy is disabled.');
  } catch (e) {
    if (stale() || e.code === 'account_changed') return;
    clearTranscript();
    setError(explain(e));
  }
}

// ---- Export ----

// Texts as currently displayed: translated (where done) or original.
function currentTexts() {
  if (!shown) return [];
  const cache = viewLang ? translations.get(viewLang) : null;
  return shown.items.map((s) => (cache?.has(s.text) ? cache.get(s.text) : s.text));
}

function exportText() {
  const { meeting, items } = shown;
  const heading = F.meetingHeading(meeting);
  const created = F.toDate(meeting.createdAt);
  const texts = currentTexts();
  const head = [
    heading.isCustom ? heading.title : `${heading.platform} meeting ${heading.title}`,
    created ? created.toLocaleString() : '',
    viewLang ? `Translated to ${F.languageName(viewLang)} on this device from the saved transcript.` : '',
    'Exported from MeetMemo',
  ].filter(Boolean);
  return `${head.join('\n')}\n\n${items.map((s, i) => lineFor(s, texts[i] ?? s.text)).join('\n')}\n`;
}

$('copy').addEventListener('click', async () => {
  if (!lines.length) return;
  const texts = viewLang && shown ? currentTexts() : null;
  const text = texts ? shown.items.map((s, i) => lineFor(s, texts[i])).join('\n') : lines.join('\n');
  await navigator.clipboard.writeText(text);
  $('copy').textContent = 'Copied';
  setTimeout(() => { $('copy').textContent = 'Copy text'; }, 2000);
});

$('download')?.addEventListener('click', () => {
  if (!shown?.complete) return;
  const heading = F.meetingHeading(shown.meeting);
  const created = F.toDate(shown.meeting.createdAt);
  const stamp = created ? created.toISOString().slice(0, 10) : 'transcript';
  const name = `MeetMemo ${heading.title} ${stamp}${viewLang ? ` (${viewLang})` : ''}.txt`.replace(/[\\/:*?"<>|]+/g, '-');
  const url = URL.createObjectURL(new Blob([exportText()], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

$('print')?.addEventListener('click', () => window.print());

// ---- Translation (on-device, read-only) ----

function baseLang(code) {
  if (!code) return null;
  const c = String(code);
  if (/^zh[-_](tw|hk|hant)/i.test(c)) return 'zh-Hant';
  return c.split(/[-_]/)[0].toLowerCase();
}

async function detectSource(items) {
  const fromMeeting = baseLang(shown?.meeting?.language);
  if (fromMeeting) return fromMeeting;
  const sample = items.slice(0, 80).map((s) => s.text).join(' ').slice(0, 3000);
  try {
    if (self.LanguageDetector && sample) {
      const detector = await self.LanguageDetector.create();
      const [top] = await detector.detect(sample);
      if (top && top.detectedLanguage && top.detectedLanguage !== 'und' && top.confidence > 0.4) return baseLang(top.detectedLanguage);
    }
  } catch { /* fall through */ }
  return 'en';
}

async function setupTranslation(items) {
  const box = $('translate-box');
  const select = $('translate-to');
  if (!box || !select) return;
  if (!translatorApi() || !items.length) { box.hidden = true; return; }
  const myRun = translateRun;
  sourceLang = await detectSource(items);
  if (myRun !== translateRun) return;
  const prefs = await F.getPrefs();
  const options = [el('option', '', `Original (${F.languageName(sourceLang)})`)];
  options[0].value = '';
  const pref = prefs.readingLanguage && prefs.readingLanguage !== sourceLang ? prefs.readingLanguage : '';
  const ordered = F.LANGUAGES.filter((l) => l.code !== sourceLang);
  if (pref) ordered.sort((a, b) => (a.code === pref ? -1 : b.code === pref ? 1 : 0));
  for (const l of ordered) {
    const o = el('option', '', l.code === pref ? `${l.name} (your reading language)` : l.name);
    o.value = l.code;
    options.push(o);
  }
  select.replaceChildren(...options);
  select.value = viewLang;
  box.hidden = false;
  if (pref && !viewLang) setTranslateStatus(`Tip: choose ${F.languageName(pref)} to read this transcript in your language.`);
}

function showTexts(texts, translated) {
  if (!shown) return;
  shown.textEls.forEach((t, i) => {
    t.textContent = texts[i] ?? shown.items[i].text;
    t.className = translated ? 'text translated' : 'text';
    if (translated) t.setAttribute('title', `Original: ${shown.items[i].text}`);
    else t.removeAttribute?.('title');
  });
}

async function applyLanguage(lang, { quiet = false } = {}) {
  const myRun = ++translateRun;
  viewLang = lang;
  if (!shown) return;
  if (!lang) { showTexts(shown.items.map((s) => s.text), false); setTranslateStatus(''); return; }
  if (!translations.has(lang)) translations.set(lang, new Map());
  const cache = translations.get(lang);
  if (shown.items.every((s) => cache.has(s.text))) {
    showTexts(shown.items.map((s) => cache.get(s.text)), true);
    setTranslateStatus(`Translated to ${F.languageName(lang)} on this device. The saved transcript is unchanged.`);
    return;
  }
  const T = translatorApi();
  const select = $('translate-to');
  try {
    const availability = await T.availability({ sourceLanguage: sourceLang, targetLanguage: lang });
    if (myRun !== translateRun) return;
    if (availability === 'unavailable') {
      setTranslateStatus(`Chrome can't translate ${F.languageName(sourceLang)} to ${F.languageName(lang)} on this device.`);
      viewLang = ''; if (select) select.value = ''; showTexts(shown.items.map((s) => s.text), false);
      return;
    }
    if (!quiet) setTranslateStatus(availability === 'available' ? 'Translating…' : `Downloading the ${F.languageName(lang)} language pack…`);
    const translator = await T.create({
      sourceLanguage: sourceLang,
      targetLanguage: lang,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          if (myRun === translateRun) setTranslateStatus(`Downloading the ${F.languageName(lang)} language pack… ${Math.round((e.loaded || 0) * 100)}%`);
        });
      },
    });
    const { items, textEls } = shown;
    for (let i = 0; i < items.length; i += 1) {
      if (myRun !== translateRun || !shown || shown.textEls !== textEls) { translator.destroy?.(); return; } // language changed or reloaded
      const original = items[i].text;
      if (!cache.has(original)) cache.set(original, String(original || '').trim() ? await translator.translate(original) : original);
      textEls[i].textContent = cache.get(original);
      textEls[i].className = 'text translated';
      textEls[i].setAttribute('title', `Original: ${items[i].text}`);
      if (i % 20 === 0) setTranslateStatus(`Translating… ${i + 1} of ${items.length}`);
    }
    translator.destroy?.();
    setTranslateStatus(`Translated to ${F.languageName(lang)} on this device. The saved transcript is unchanged.`);
  } catch (e) {
    if (myRun !== translateRun) return;
    const needsClick = /activation|gesture/i.test(String(e?.message || e?.name || ''));
    setTranslateStatus(needsClick
      ? `Choose ${F.languageName(lang)} again to start the language pack download.`
      : `Translation failed: ${e?.message || 'unknown error'}.`);
    viewLang = ''; if (select) select.value = '';
    showTexts(shown.items.map((s) => s.text), false);
  }
}

$('translate-to')?.addEventListener('change', (e) => applyLanguage(e.target.value));

// ---- Live mode: follow this meeting's save status (scoped to the signed-in account) ----

function onStatus(raw) {
  if (!live || !currentUser) return;
  const entry = Object.values(statusFor(raw, currentUser)?.meetings || {}).find((m) => m.meetingId === meetingId);
  if (!entry) { setNotice(null); return; }
  if (entry.state === 'error') setNotice(`Some lines are not saved yet: ${entry.message || 'save failed'}. Retrying automatically.`);
  else if (entry.queued) setNotice(`Saving… ${entry.queued} line${entry.queued === 1 ? '' : 's'} still on the way. This page updates when they arrive.`);
  else setNotice(null);
  if (entry.savedAt && entry.savedAt !== lastSavedAt) {
    lastSavedAt = entry.savedAt;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 300); // coalesce bursts of batches
  }
}

if (params.get('error')) {
  clearTranscript();
  setError(`Could not open this meeting's transcript: ${params.get('error')}`);
} else if (!meetingId) {
  clearTranscript();
  setError('No meeting id in the address.');
} else {
  auth.onAuthStateChanged(async (user) => {
    const changed = !currentUser || !user || currentUser.uid !== user.uid || currentUser.sid !== user.sid;
    if (!changed) { currentUser = user; return; }
    gen += 1; // invalidate anything loading for the previous identity
    currentUser = user;
    askPanel?.setUser(user); // stops any answer in progress and clears the old account's conversation
    livePanel?.setUser(user); // drops the old account's cards; the worker stops its work on its own
    clearTranscript();
    setNotice(null);
    lastSavedAt = null;
    if (!user) { setError('Signed out. Sign in from the MeetMemo popup to view this transcript.'); return; }
    await load();
    onStatus((await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY]);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STATUS_KEY]) onStatus(changes[STATUS_KEY].newValue);
  });
}

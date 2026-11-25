// Read-only, private transcript viewer for a meeting saved by the sync layer.
//
// - Loads every page of segments (the backend pages by (ts, id)); the line count and Copy
//   cover the whole meeting, and a partial load is labelled as such.
// - Follows the local session: on sign-out or an account switch the rendered text and the
//   copy buffer are cleared, in-flight loads are discarded, and a new account must be
//   authorized by the backend (ownership check) before anything is shown again.
// - With ?live=1 (opened from the meeting panel) it follows that meeting's save status and
//   reloads as queued lines reach the backend.
import { createAuthProvider, createClient } from './extension-auth/index.js';

const { STATUS_KEY, statusFor } = self.MeetMemoSession;
const auth = createAuthProvider();
const api = createClient(auth);
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const meetingId = params.get('id');
const live = params.get('live') === '1';

let currentUser = null;
let gen = 0; // identity/load generation; stale loads compare against it
let lines = []; // copy buffer for the currently rendered transcript
let lastSavedAt = null;
let reloadTimer = null;

function toDate(t) {
  if (!t) return null;
  const s = t.seconds ?? t._seconds;
  return typeof s === 'number' ? new Date(s * 1000) : new Date(t);
}

function setError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}

function setNotice(message) {
  $('notice').textContent = message || '';
  $('notice').hidden = !message;
}

function clearTranscript(title = 'Transcript') {
  lines = [];
  $('segments').replaceChildren();
  $('copy').hidden = true;
  $('copy').textContent = 'Copy text';
  $('title').textContent = title;
  $('meta').textContent = '';
  document.title = 'Transcript · MeetMemo';
}

function renderSegments(meeting, items, complete) {
  document.title = `${meeting.title} · MeetMemo`;
  $('title').textContent = meeting.title;
  const count = `${items.length} line${items.length === 1 ? '' : 's'}${complete ? '' : ' (incomplete)'}`;
  $('meta').textContent = [toDate(meeting.createdAt)?.toLocaleString(), count, 'Private: visible only to your account'].filter(Boolean).join(' · ');
  const out = [];
  const frag = document.createDocumentFragment();
  for (const s of items) {
    const row = document.createElement('div');
    row.className = 'segment';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const speaker = document.createElement('span');
    speaker.className = 'speaker';
    speaker.textContent = s.speaker || 'Unknown speaker';
    const time = new Date(s.ts).toLocaleTimeString();
    meta.append(speaker, time);
    const text = document.createElement('div');
    text.textContent = s.text;
    row.append(meta, text);
    frag.append(row);
    out.push(`[${time}] ${s.speaker || 'Unknown speaker'}: ${s.text}`);
  }
  $('segments').replaceChildren(frag);
  if (!items.length) $('segments').textContent = live ? 'No lines saved yet. New lines appear here as they are saved.' : 'No lines saved yet.';
  lines = complete ? out : [];
  $('copy').hidden = !complete || !items.length; // never copy a partial transcript as if it were whole
}

function explain(e) {
  if (e.code === 'unauthenticated') return 'Sign in from the MeetMemo popup to view this transcript.';
  if (e.status === 404) return 'Meeting not found for this account.';
  if (e instanceof TypeError || e?.name === 'TimeoutError') return "Can't reach the backend. Is it running?";
  return e.message || 'Could not load the transcript.';
}

async function load() {
  const myGen = ++gen;
  const user = currentUser;
  if (!user) return;
  setError(null);
  const stale = () => myGen !== gen; // identity changes and newer loads both bump gen
  try {
    $('meta').textContent = 'Loading…';
    const meeting = await api.getMeeting(meetingId, { expectUid: user.uid }); // backend ownership check
    if (stale()) return;
    const { items, complete } = await api.listAllSegments(meetingId, {
      expectUid: user.uid,
      onPage: (sofar) => { if (!stale()) $('meta').textContent = `Loading… ${sofar.length} lines`; },
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

// Live mode: follow this meeting's save status (scoped to the signed-in account).
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

$('copy').addEventListener('click', async () => {
  if (!lines.length) return;
  await navigator.clipboard.writeText(lines.join('\n'));
  $('copy').textContent = 'Copied';
});

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

// Transcription history: every meeting saved to the signed-in account, grouped by day, with a
// short readable preview of each transcript. Read-only except for Delete (with confirmation).
//
// Follows the local session like the other pages: on sign-out or an account switch the list is
// cleared and in-flight loads are discarded (each load carries the generation it started in).
import { settings, createAuthProvider, createClient } from './extension-auth/index.js';
import { readDocument, mimeFor } from './ui/docText.js';

const F = self.MeetMemoFormat;
const auth = createAuthProvider();
const api = createClient(auth);
const $ = (id) => document.getElementById(id);

const PREVIEW_LINES = 3;
const PREVIEW_CONCURRENCY = 4;

let currentUser = null;
let gen = 0;
let cursor = null;
let meetings = []; // { m, heading, created, updated, previewText, card }
let previewQueue = [];
let previewActive = 0;

function show(view) {
  for (const v of ['loading', 'signed-out', 'empty', 'list']) $(`view-${v}`).hidden = v !== view;
  $('search-wrap').hidden = view !== 'list';
}

function setError(msg) {
  $('error').textContent = msg || '';
  $('error').hidden = !msg;
}

function friendly(e) {
  if (e instanceof TypeError || e?.name === 'TimeoutError') return `Can't reach the MeetMemo server (${settings.apiBaseUrl}).`;
  if (e?.status >= 500) return 'The server hit an error loading your meetings. Try again in a moment.';
  return e?.message || 'Something went wrong.';
}

const svg = (paths) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = paths; // static markup only, never user data
  return s;
};
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const transcriptUrl = (id) => `transcript.html?id=${encodeURIComponent(id)}`;

function buildCard(item) {
  const { m, heading, created, updated } = item;
  const card = el('article', 'card meeting-card');

  const head = el('div', 'head');
  const platform = el('div', 'platform');
  platform.append(el('span', 'dot'), heading.platform);
  const h3 = el('h3');
  const link = el('a');
  link.href = transcriptUrl(m.id);
  if (heading.isCustom) link.textContent = heading.title;
  else link.append(el('span', 'code', heading.title));
  h3.append(link);
  const meta = el('div', 'meta');
  meta.append(el('span', '', F.longDate(created)));
  if (created) meta.append(el('span', '', updated && updated - created > 60000 ? `${F.time(created)} – ${F.time(updated)}` : F.time(created)));
  if (created && updated && updated - created > 60000) meta.append(el('span', '', F.duration(updated - created)));
  if (heading.isCustom && heading.code) meta.append(el('span', '', heading.code));
  head.append(platform, h3, meta);

  const actions = el('div', 'actions');
  const open = el('a', 'btn small', 'Open transcript');
  open.href = transcriptUrl(m.id);
  const askAi = el('a', 'btn small ghost', 'Ask Meet Memo');
  askAi.href = `${transcriptUrl(m.id)}&ask=1`;
  askAi.title = 'Ask questions about this meeting';
  const del = el('button', 'btn small ghost danger');
  del.type = 'button';
  del.title = 'Delete this meeting and its transcript';
  del.setAttribute('aria-label', `Delete meeting ${heading.title}`);
  del.append(svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'));
  del.addEventListener('click', () => removeMeeting(item, del));
  actions.append(open, askAi, del);

  const preview = el('div', 'preview');
  preview.append(el('span', 'skeleton'), el('span', 'skeleton'));
  preview.lastChild.style.width = '70%';

  card.append(head, actions, preview);
  item.card = card;
  item.preview = preview;
  return card;
}

function renderPreview(item, segments) {
  const box = item.preview;
  box.replaceChildren();
  const lines = segments.filter((s) => String(s.text || '').trim()).slice(0, PREVIEW_LINES);
  if (!lines.length) {
    box.append(el('span', 'none', 'No transcript lines were saved for this meeting.'));
    item.previewText = '';
    return;
  }
  for (const s of lines) {
    const p = el('p');
    p.append(el('span', 'who', s.speaker || 'Unknown speaker'), s.text);
    box.append(p);
  }
  item.previewText = lines.map((s) => `${s.speaker || ''} ${s.text}`).join(' ').toLowerCase();
  applySearch();
}

function queuePreview(item) {
  previewQueue.push(item);
  pumpPreviews();
}

function pumpPreviews() {
  while (previewActive < PREVIEW_CONCURRENCY && previewQueue.length) {
    const item = previewQueue.shift();
    const myGen = gen;
    const user = currentUser;
    if (!user) return;
    previewActive += 1;
    api.listSegmentsPage(item.m.id, { limit: PREVIEW_LINES + 3, expectUid: user.uid })
      .then((r) => { if (myGen === gen) renderPreview(item, r.items || []); })
      .catch(() => {
        if (myGen !== gen) return;
        item.preview.replaceChildren(el('span', 'none', 'Preview unavailable. Open the transcript to read it.'));
      })
      .finally(() => { previewActive -= 1; pumpPreviews(); });
  }
}

function render() {
  const groups = new Map();
  for (const item of meetings) {
    const label = F.dayLabel(item.created);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  }
  const frag = document.createDocumentFragment();
  for (const [label, items] of groups) {
    const section = el('section', 'day-group');
    section.append(el('h2', 'day-label', label));
    const list = el('div', 'meeting-list');
    for (const item of items) list.append(item.card || buildCard(item));
    section.append(list);
    section.groupItems = items; // used by search filtering
    frag.append(section);
  }
  $('groups').replaceChildren(frag);
  $('count-line').textContent = `${meetings.length} meeting${meetings.length === 1 ? '' : 's'}${cursor ? ' loaded' : ''}`;
  show(meetings.length ? 'list' : 'empty');
  applySearch();
}

function applySearch() {
  const q = $('search').value.trim().toLowerCase();
  let visible = 0;
  for (const section of $('groups').children) {
    let any = false;
    for (const item of section.groupItems || []) {
      const hay = `${item.heading.title} ${item.heading.code} ${item.m.title || ''} ${item.previewText || ''}`.toLowerCase();
      const match = !q || hay.includes(q);
      item.card.hidden = !match;
      if (match) { any = true; visible += 1; }
    }
    section.hidden = !any;
  }
  $('no-results').hidden = !q || visible > 0;
}

async function load({ more = false } = {}) {
  const myGen = gen;
  const user = currentUser;
  if (!user) return;
  setError(null);
  $('more').disabled = true;
  try {
    const { items, next } = await api.listMeetings(more ? cursor : undefined, { expectUid: user.uid });
    if (myGen !== gen) return;
    $('backend-warning').hidden = true;
    cursor = next;
    const fresh = items.map((m) => ({ m, heading: F.meetingHeading(m), created: F.toDate(m.createdAt), updated: F.toDate(m.updatedAt) }));
    meetings = more ? meetings.concat(fresh) : fresh;
    render();
    fresh.forEach(queuePreview);
    $('more').hidden = !cursor;
  } catch (e) {
    if (myGen !== gen || e.code === 'account_changed') return;
    if (e instanceof TypeError || e?.name === 'TimeoutError') {
      $('backend-warning').hidden = false;
      setTimeout(() => { if (myGen === gen) load({ more }); }, 15000);
    }
    setError(`Couldn't load meetings. ${friendly(e)}`);
    if (!meetings.length) show('empty');
  } finally {
    $('more').disabled = false;
  }
}

async function removeMeeting(item, button) {
  const label = item.heading.isCustom ? item.heading.title : `meeting ${item.heading.title}`;
  if (!confirm(`Delete ${label}? The transcript is permanently removed from your account. This cannot be undone.`)) return;
  const myGen = gen;
  button.disabled = true;
  try {
    await api.deleteMeeting(item.m.id);
    // The backend deleted the meeting's AI cards with it; drop this device's copies and its
    // Auto-answer setting too.
    if (currentUser) {
      chrome.storage.local.remove(`meetmemo_autoanswer:${currentUser.uid}:${item.m.id}`).catch(() => {});
      chrome.storage.session?.remove(`meetmemo_live:${currentUser.uid}:${item.m.id}`).catch(() => {});
    }
    if (myGen !== gen) return;
    meetings = meetings.filter((x) => x !== item);
    render();
  } catch (e) {
    if (myGen !== gen) return;
    setError(`Couldn't delete the meeting. ${friendly(e)}`);
    button.disabled = false;
  }
}

// ---- Meeting documents: context for the Claude tab's assistant actions in the Meet panel ----
let docs = [];
let uploading = false;

function docStatus(msg, kind = '') {
  const s = $('doc-status');
  s.textContent = msg || '';
  s.className = `notice${kind ? ` ${kind}` : ''}`;
  s.hidden = !msg;
}

// Server errors with their own wording (Claude busy, timed out, unreadable file) are shown as is.
function docError(e) {
  if (e?.status >= 500 && e.code && e.code !== 'internal_error' && e.message) return e.message;
  if (e?.status >= 500) return 'The server hit an error. Try again in a moment.';
  return friendly(e);
}

const fmtChars = (n) => `${n.toLocaleString()} character${n === 1 ? '' : 's'}`;
const docBadge = (name) => ((String(name).match(/\.([a-z0-9]{1,4})$/i) || [])[1] || 'doc').toUpperCase();

function renderDocs() {
  const list = $('doc-list');
  list.replaceChildren(...docs.map((d) => {
    const li = el('li', `doc-item${d.active ? '' : ' off'}`);
    const icon = el('span', 'doc-icon', docBadge(d.name));
    icon.setAttribute('aria-hidden', 'true');
    const main = el('div', 'doc-main');
    const name = el('div', 'doc-name', d.name);
    name.title = d.name;
    const meta = el('div', 'doc-meta');
    meta.append(el('span', '', fmtChars(d.chars)));
    if (d.source === 'extracted') meta.append(el('span', '', 'Read by Claude'));
    if (d.createdAt) meta.append(el('span', '', `Added ${F.longDate(new Date(d.createdAt))}`));
    if (d.truncated) meta.append(el('span', 'warn', 'Long file: only the first part is used'));
    main.append(name, meta);

    const actions = el('div', 'doc-actions');
    const toggle = el('label', 'doc-toggle');
    const box = el('input');
    box.type = 'checkbox';
    box.setAttribute('role', 'switch');
    box.checked = d.active;
    box.setAttribute('aria-label', `Use ${d.name} in meetings`);
    box.addEventListener('change', () => toggleDoc(d, box));
    toggle.append(box, el('span', '', 'Use in meetings'));
    const del = el('button', 'btn small ghost danger');
    del.type = 'button';
    del.title = 'Delete this document';
    del.setAttribute('aria-label', `Delete ${d.name}`);
    del.append(svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'));
    del.addEventListener('click', () => deleteDoc(d, del));
    actions.append(toggle, del);

    li.append(icon, main, actions);
    if (d.preview) li.append(el('p', 'doc-preview', d.preview));
    return li;
  }));
  $('doc-empty').hidden = docs.length > 0;
}

async function loadDocs() {
  const myGen = gen;
  const user = currentUser;
  if (!user) return;
  try {
    const r = await api.listContextDocs({ expectUid: user.uid });
    if (myGen !== gen) return;
    docs = r.items || [];
    renderDocs();
  } catch (e) {
    if (myGen !== gen || e.code === 'account_changed') return;
    if (e.code === 'route_not_found') docStatus('This MeetMemo server is out of date. Deploy the latest backend to upload meeting documents.', 'warn');
    else docStatus(`Couldn't load your documents. ${docError(e)}`, 'error');
  }
}

async function uploadFiles(files) {
  if (uploading || !files.length) return;
  const myGen = gen;
  const user = currentUser;
  if (!user) return;
  uploading = true;
  $('doc-upload').disabled = true;
  const failed = [];
  let added = 0;
  for (const file of files) {
    try {
      docStatus(`Reading ${file.name}…`);
      const doc = await readDocument(file);
      if (doc.kind === 'data') docStatus(`Claude is reading ${file.name}. Long PDFs can take a minute or two…`);
      else docStatus(`Uploading ${file.name}…`);
      const saved = await api.uploadContextDoc({
        name: file.name.slice(0, 200),
        mimeType: mimeFor(file),
        size: file.size,
        ...(doc.kind === 'data' ? { data: doc.data } : { text: doc.text }),
      }, { expectUid: user.uid });
      if (myGen !== gen) return;
      docs.push(saved);
      added += 1;
      renderDocs();
    } catch (e) {
      if (myGen !== gen) return;
      failed.push(e instanceof TypeError || e?.name === 'TimeoutError' || e?.status ? `${file.name}: ${docError(e)}` : `${e.message}`);
    }
  }
  uploading = false;
  $('doc-upload').disabled = false;
  if (myGen !== gen) return;
  if (failed.length) docStatus(`${added ? `Added ${added}. ` : ''}Couldn't add ${failed.length === 1 ? 'a file' : `${failed.length} files`}: ${failed.join(' ')}`, 'error');
  else docStatus(`Added ${added} document${added === 1 ? '' : 's'}. Claude will use ${added === 1 ? 'it' : 'them'} in your next meeting.`, 'ok');
}

async function toggleDoc(d, box) {
  box.disabled = true;
  try {
    const updated = await api.updateContextDoc(d.id, { active: box.checked }, { expectUid: currentUser?.uid });
    Object.assign(d, updated);
    docStatus('');
  } catch (e) {
    box.checked = d.active;
    docStatus(`Couldn't change the document. ${docError(e)}`, 'error');
  } finally {
    box.disabled = false;
    renderDocs();
  }
}

async function deleteDoc(d, button) {
  if (!confirm(`Delete "${d.name}"? Claude will no longer use it in your meetings.`)) return;
  button.disabled = true;
  try {
    await api.deleteContextDoc(d.id, { expectUid: currentUser?.uid });
    docs = docs.filter((x) => x !== d);
    renderDocs();
    docStatus('');
  } catch (e) {
    button.disabled = false;
    docStatus(`Couldn't delete the document. ${docError(e)}`, 'error');
  }
}

$('doc-upload').addEventListener('click', () => $('doc-file').click());
$('doc-file').addEventListener('change', (ev) => {
  const files = [...ev.target.files];
  ev.target.value = ''; // the same file can be chosen again
  uploadFiles(files);
});

$('search').addEventListener('input', applySearch);
$('more').addEventListener('click', () => load({ more: true }));
$('sign-in').addEventListener('click', () => {
  chrome.windows.create({ url: chrome.runtime.getURL('auth.html'), type: 'popup', width: 380, height: 640 });
});

auth.onAuthStateChanged((user) => {
  const changed = !currentUser || !user || currentUser.uid !== user.uid || currentUser.sid !== user.sid;
  currentUser = user;
  if (!changed) return;
  gen += 1;
  meetings = []; cursor = null; previewQueue = [];
  $('groups').replaceChildren();
  $('search').value = '';
  setError(null);
  $('nav-who').textContent = user ? (user.email || user.displayName || '') : '';
  docs = []; $('doc-list').replaceChildren(); $('doc-empty').hidden = true; docStatus('');
  $('context-docs').hidden = !user;
  if (!user) { show('signed-out'); return; }
  loadDocs();
  $('subtitle').textContent = `Meetings saved to ${user.email || 'your account'}, newest first. Only you can see them.`;
  show('loading');
  load();
});

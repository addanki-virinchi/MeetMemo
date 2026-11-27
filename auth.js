// Popup: sign in / create account against the local backend, show live sync status
// and recent meetings. Auth logic lives in extension-auth/; this file is UI only.
//
// Every identity change (here or in any other page, or the worker removing a rejected
// session) re-renders the popup. Async loads carry the identity they were started for and
// are dropped if the identity changed before they finished.
import { settings, createAuthProvider, createClient } from './extension-auth/index.js';
import { AuthNotConfiguredError } from './extension-auth/authProvider.js';

const { STATUS_KEY, statusFor } = self.MeetMemoSession;

const auth = createAuthProvider();
const api = createClient(auth);
const $ = (id) => document.getElementById(id);
let mode = 'signin';
let currentUser = null; // identity the popup is currently rendering
let gen = 0; // bumps on every identity change; stale async work compares against it
let nextMeetingsCursor = null;
const listedMeetingIds = new Set();
const profileSetupStarted = new Set(); // sids whose automatic profile setup already ran here

// Firestore timestamps arrive as { _seconds } or { seconds } depending on the SDK version.
function toDate(t) {
  if (!t) return null;
  const s = t.seconds ?? t._seconds;
  return typeof s === 'number' ? new Date(s * 1000) : new Date(t);
}

function show(view) {
  for (const v of ['loading', 'signed-out', 'signed-in']) $(`view-${v}`).hidden = v !== view;
}

function friendlyError(err) {
  if (err instanceof AuthNotConfiguredError) return err.message;
  if (err instanceof TypeError || err?.name === 'TimeoutError') return `Can't reach the backend at ${settings.apiBaseUrl}.`;
  switch (err.code) {
    case 'invalid_credentials': return err.message === 'Google sign-in was rejected' ? err.message : 'Wrong email or password.';
    case 'cancelled': return 'Google sign-in was cancelled.';
    case 'provider_disabled': return err.message;
    case 'google_failed': return `Google sign-in failed: ${err.message}`;
    case 'email_in_use': return 'An account with this email already exists. Sign in instead.';
    case 'invalid_request': return 'Check the form: a valid email and a password of at least 8 characters are required.';
    default:
      if (err.status === 429) return 'Too many attempts. Wait a minute and try again.';
      if (err.status === 404) return 'Email sign-in is turned off on the server.';
      if (err.status >= 500) return 'The server hit an error. Try again; if it keeps happening, check the server logs.';
      return err.message || 'Something went wrong.';
  }
}

async function checkBackend() {
  $('api-url').textContent = settings.apiBaseUrl;
  try {
    const res = await fetch(`${settings.apiBaseUrl}/healthz`, { signal: AbortSignal.timeout(60_000) });
    $('backend-warning').hidden = res.ok;
  } catch {
    $('backend-warning').hidden = false;
  }
}

// ---- Signed-out view ----

function setMode(next) {
  mode = next;
  const signup = mode === 'signup';
  $('tab-signin').setAttribute('aria-selected', String(!signup));
  $('tab-signup').setAttribute('aria-selected', String(signup));
  $('name-field').hidden = !signup;
  $('auth-form').password.autocomplete = signup ? 'new-password' : 'current-password';
  $('submit').textContent = signup ? 'Create account' : 'Sign in';
  $('form-error').hidden = true;
}

async function onSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const name = form.name.value.trim();
  const email = form.email.value.trim();
  const password = form.password.value;
  $('form-error').hidden = true;

  if (mode === 'signup' && !name) return showFormError('Enter your name.');
  if (!email || !form.email.checkValidity()) return showFormError('Enter a valid email address.');
  if (password.length < 8) return showFormError('Password must be at least 8 characters.');

  $('submit').disabled = true;
  let user;
  try {
    user = mode === 'signup' ? await auth.signUp({ name, email, password }) : await auth.signIn({ email, password });
    form.reset();
  } catch (e) {
    // Only authentication failures belong in the sign-in form.
    showFormError(friendlyError(e));
    return;
  } finally {
    $('submit').disabled = false;
  }
  // Authentication succeeded; profile setup is a separate step shown in the signed-in view.
  setupProfile(user);
}

function showFormError(message) {
  $('form-error').textContent = message;
  $('form-error').hidden = false;
}

// ---- Profile setup (POST /v1/users/me) ----

async function setupProfile(user) {
  if (!user) return;
  profileSetupStarted.add(user.sid);
  $('profile-retry').disabled = true;
  try {
    await api.registerUser({ expectUid: user.uid }); // creates or refreshes the users/{uid} profile
    await auth.setProfileState(user.sid, 'ready');
  } catch (e) {
    if (e.code === 'account_changed' || e.code === 'unauthenticated') return;
    await auth.setProfileState(user.sid, 'error', friendlyError(e)).catch(() => {});
  } finally {
    $('profile-retry').disabled = false;
  }
}

function renderProfile(user) {
  const failed = user.profile.state === 'error';
  $('profile-warning').hidden = !failed;
  if (failed) {
    $('profile-warning-text').textContent = `Signed in, but your profile could not be set up: ${user.profile.message || 'unknown error'}`;
  }
  // A session from an older version, or a popup closed mid-setup: finish setup once.
  if ((user.profile.state === 'pending' || user.profile.state === 'unknown') && !profileSetupStarted.has(user.sid)) {
    setupProfile(user);
  }
}

// ---- Live sync status ----

function describe(m) {
  const code = m.meetingCode ? ` (${m.meetingCode})` : '';
  const when = new Date(m.savedAt || m.at).toLocaleTimeString();
  const waiting = m.queued ? ` ${m.queued} line${m.queued === 1 ? '' : 's'} waiting.` : '';
  const dropped = m.dropped ? ` ${m.dropped} line${m.dropped === 1 ? ' was' : 's were'} dropped because the unsaved queue was full.` : '';
  switch (m.state) {
    case 'saved': return { text: `Saved${code} at ${when}.${dropped}`, error: !!m.dropped };
    case 'saving': return { text: `Saving${code}…${waiting}${dropped}`, error: !!m.dropped };
    case 'error': return { text: `Save failed${code} at ${new Date(m.at).toLocaleTimeString()}: ${m.message || 'unknown error'}.${waiting} Retrying automatically.${dropped}`, error: true };
    default: return { text: `Waiting${code}.${waiting}`, error: false };
  }
}

function renderStatus(rawStatus) {
  const el = $('sync-status');
  el.replaceChildren();
  const status = statusFor(rawStatus, currentUser); // never another account's or session's status
  const meetings = status ? Object.values(status.meetings || {}).sort((a, b) => b.at - a.at) : [];
  if (!meetings.length) {
    const p = document.createElement('p');
    p.textContent = 'Join a Google Meet, Zoom or Microsoft Teams meeting in the browser and turn on captions; lines are saved every few seconds.';
    el.append(p);
    return;
  }
  for (const m of meetings) {
    const { text, error } = describe(m);
    const p = document.createElement('p');
    p.textContent = text;
    if (error) p.className = 'notice notice-error';
    el.append(p);
    // A meeting created while the popup is open appears in Recent meetings without reopening.
    if (m.meetingId && !listedMeetingIds.has(m.meetingId)) scheduleMeetingsReload();
  }
}

// ---- Recent meetings ----

let reloadTimer = null;
function scheduleMeetingsReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => loadMeetings(), 1000);
}

function appendMeetings(items) {
  for (const m of items) {
    listedMeetingIds.add(m.id);
    const a = document.createElement('a');
    a.href = chrome.runtime.getURL(`transcript.html?id=${encodeURIComponent(m.id)}`);
    a.target = '_blank';
    const title = document.createElement('span');
    title.className = 'title';
    const heading = self.MeetMemoFormat?.meetingHeading(m);
    title.textContent = heading ? (heading.isCustom ? heading.title : `${heading.platform} · ${heading.title}`) : (m.title || 'Untitled meeting');
    const meta = document.createElement('span');
    meta.className = 'muted small';
    meta.textContent = toDate(m.createdAt)?.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) ?? '';
    a.append(title, meta);
    const li = document.createElement('li');
    li.append(a);
    $('meetings').append(li);
  }
}

async function loadMeetings({ more = false } = {}) {
  const myGen = gen;
  const user = currentUser;
  if (!user) return;
  $('meetings-error').hidden = true;
  $('meetings-more').disabled = true;
  try {
    const { items, next } = await api.listMeetings(more ? nextMeetingsCursor : undefined, { expectUid: user.uid });
    if (myGen !== gen) return; // identity changed while loading
    if (!more) {
      $('meetings').replaceChildren();
      listedMeetingIds.clear();
    }
    appendMeetings(items.slice(0, 10));
    nextMeetingsCursor = items.length > 10 ? items[9].id : next;
    $('meetings-empty').hidden = listedMeetingIds.size > 0;
    $('meetings-more').hidden = !nextMeetingsCursor;
  } catch (e) {
    if (myGen !== gen || e.code === 'account_changed') return;
    // A missing Firestore index shows up here as a 500; see "Local testing" in README.md.
    $('meetings-error').textContent = `Couldn't load meetings: ${friendlyError(e)}`;
    $('meetings-error').hidden = false;
  } finally {
    $('meetings-more').disabled = false;
  }
}

// ---- Identity rendering ----

function clearSignedInView() {
  $('user-name').textContent = '';
  $('user-email').textContent = '';
  $('profile-warning').hidden = true;
  $('meetings').replaceChildren();
  listedMeetingIds.clear();
  nextMeetingsCursor = null;
  $('meetings-empty').hidden = true;
  $('meetings-error').hidden = true;
  $('meetings-more').hidden = true;
  $('sync-status').replaceChildren();
}

async function renderSignedIn(user, identityChanged) {
  $('user-name').textContent = user.displayName || user.email;
  $('user-email').textContent = user.displayName ? user.email : '';
  show('signed-in');
  renderProfile(user);
  if (!identityChanged) return; // only the profile state changed
  const myGen = gen;
  const status = (await chrome.storage.local.get(STATUS_KEY))[STATUS_KEY];
  if (myGen !== gen) return;
  renderStatus(status);
  loadMeetings();
}

$('tab-signin').addEventListener('click', () => setMode('signin'));
$('tab-signup').addEventListener('click', () => setMode('signup'));
$('auth-form').addEventListener('submit', onSubmit);
$('google-signin').addEventListener('click', async () => {
  $('form-error').hidden = true;
  $('google-signin').disabled = true;
  try {
    // The flow runs in the service worker; if this popup closes meanwhile, reopening it shows the result.
    setupProfile(await auth.signInWithGoogle());
  } catch (e) {
    if (e.code !== 'cancelled') showFormError(friendlyError(e));
  } finally {
    $('google-signin').disabled = false;
  }
});
$('sign-out').addEventListener('click', () => auth.signOut().catch((e) => alert(friendlyError(e))));
const openPage = (name) => chrome.tabs.create({ url: chrome.runtime.getURL(`${name}.html`) });
$('open-options').addEventListener('click', () => openPage('settings'));
$('open-help').addEventListener('click', () => openPage('help'));
$('open-privacy').addEventListener('click', () => openPage('privacy'));
$('open-history').addEventListener('click', () => openPage('history'));
$('profile-retry').addEventListener('click', () => setupProfile(currentUser));
$('meetings-more').addEventListener('click', () => loadMeetings({ more: true }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STATUS_KEY]) renderStatus(changes[STATUS_KEY].newValue);
});

auth.onAuthStateChanged((user) => {
  const identityChanged = !currentUser || !user || currentUser.uid !== user.uid || currentUser.sid !== user.sid;
  if (identityChanged) {
    gen += 1;
    clearSignedInView();
  }
  currentUser = user;
  if (user) renderSignedIn(user, identityChanged);
  else { setMode(mode); show('signed-out'); }
});

checkBackend();

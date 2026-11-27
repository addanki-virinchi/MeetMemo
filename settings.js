// Settings page: account, language preferences (reading/translation and Ask Meet Memo), data links and
// a server connection check. Preferences live in chrome.storage.local (MeetMemoFormat.PREFS_KEY).
import { settings, createAuthProvider } from './extension-auth/index.js';

const F = self.MeetMemoFormat;
const auth = createAuthProvider();
const $ = (id) => document.getElementById(id);

function fillLanguages(select, firstLabel, value) {
  const first = document.createElement('option');
  first.value = '';
  first.textContent = firstLabel;
  const opts = [first];
  for (const l of F.LANGUAGES) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = l.name;
    opts.push(o);
  }
  select.replaceChildren(...opts);
  select.value = value || '';
}

let flashTimer = null;
function flash(text) {
  $('saved').textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $('saved').textContent = ''; }, 2500);
}

async function initPreferences() {
  const prefs = await F.getPrefs();
  fillLanguages($('reading-language'), 'Original language (no translation)', prefs.readingLanguage);
  fillLanguages($('ai-language'), 'Same as the meeting', prefs.aiLanguage);
  $('reading-language').addEventListener('change', async (e) => {
    await F.setPrefs({ readingLanguage: e.target.value });
    flash(e.target.value ? `Saved. Transcripts will offer ${F.languageName(e.target.value)} first.` : 'Saved. Transcripts open in their original language.');
  });
  $('ai-language').addEventListener('change', async (e) => {
    await F.setPrefs({ aiLanguage: e.target.value });
    flash(e.target.value ? `Saved. Ask Meet Memo will answer in ${F.languageName(e.target.value)}.` : 'Saved. Ask Meet Memo will answer in the language you ask in.');
  });

  const support = $('translator-support');
  if (!self.Translator) {
    support.textContent = 'This browser does not have Chrome’s built-in translator (Chrome 138 or later on desktop). Transcripts will still open in their original language.';
    return;
  }
  support.textContent = 'Supported in this browser. Language packs download once, the first time you use them.';
}

async function checkServer() {
  $('api-url').textContent = settings.apiBaseUrl;
  $('server-status').textContent = 'Checking… (a sleeping server can take up to a minute)';
  $('check-server').disabled = true;
  const started = Date.now();
  try {
    const res = await fetch(`${settings.apiBaseUrl}/healthz`, { signal: AbortSignal.timeout(70_000) });
    const ms = Date.now() - started;
    $('server-status').textContent = res.ok ? `Connected (${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`})` : `Server answered with an error (HTTP ${res.status})`;
  } catch {
    $('server-status').textContent = 'Not reachable right now. Check your internet connection and try again.';
  } finally {
    $('check-server').disabled = false;
  }
}

$('sign-in').addEventListener('click', () => {
  chrome.windows.create({ url: chrome.runtime.getURL('auth.html'), type: 'popup', width: 380, height: 640 });
});
$('sign-out').addEventListener('click', async () => {
  $('sign-out').disabled = true;
  try { await auth.signOut(); } catch (e) { alert(e?.message || 'Could not sign out.'); } finally { $('sign-out').disabled = false; }
});
$('check-server').addEventListener('click', checkServer);

// Zoom web client redirect: a static ruleset (rules/zoom-web-client.json), on by default.
const ZOOM_RULESET = 'zoom_web_client';
async function initZoomRedirect() {
  const box = $('zoom-web-client');
  const dnr = chrome.declarativeNetRequest;
  if (!dnr?.getEnabledRulesets) { box.disabled = true; return; }
  box.checked = (await dnr.getEnabledRulesets()).includes(ZOOM_RULESET);
  box.addEventListener('change', async () => {
    box.disabled = true;
    try {
      await dnr.updateEnabledRulesets(box.checked ? { enableRulesetIds: [ZOOM_RULESET] } : { disableRulesetIds: [ZOOM_RULESET] });
      flash(box.checked ? 'Saved. Zoom links will open in the browser.' : 'Saved. Zoom links will open the way Zoom decides (usually the Zoom app).');
    } catch (e) {
      box.checked = !box.checked;
      flash(`Could not change this setting: ${e?.message || e}`);
    } finally {
      box.disabled = false;
    }
  });
}
initZoomRedirect();
$('api-url').textContent = settings.apiBaseUrl;

auth.onAuthStateChanged((user) => {
  $('sign-in').hidden = !!user;
  $('sign-out').hidden = !user;
  $('nav-who').textContent = user ? (user.email || '') : '';
  $('account-name').textContent = user ? (user.displayName || user.email) : 'Not signed in';
  $('account-email').textContent = user ? (user.displayName ? user.email : 'Signed in') : 'Sign in to save Google Meet, Zoom and Microsoft Teams transcripts.';
});

initPreferences();

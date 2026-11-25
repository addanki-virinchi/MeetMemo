// Shared local-session identity helpers (no tokens leave this module's return values).
//
// One classic script, usable everywhere the extension runs:
//   - extension pages:   import './extension-auth/session.js' (side effect) or <script src>
//   - service worker:    importScripts('extension-auth/session.js')
//   - content scripts:   listed in manifest.json before the scripts that use it
// It defines self.MeetMemoSession. The service worker (extension-auth/sessionAuthority.js)
// is the only writer of the session record; every other context only reads and subscribes.
(() => {
  const KEY = 'meetmemo_session'; // chrome.storage.local; written only by sessionAuthority.js
  const STATUS_KEY = 'meetmemo_sync_status'; // chrome.storage.local; written only by sync/worker.js

  // Sessions written before session ids existed get a stable derived id, so an upgrade does
  // not look like an account switch.
  const sidOf = (s) => (s ? s.sid || `legacy-${s.uid}` : null);

  // Public identity: what UIs may know. Never includes tokens.
  function toUser(s) {
    if (!s || !s.uid) return null;
    return {
      uid: s.uid,
      sid: sidOf(s),
      email: s.email ?? null,
      displayName: s.displayName ?? null,
      // Profile setup (POST /v1/users/me) is tracked separately from authentication.
      profile: s.profile ? { state: s.profile.state, message: s.profile.message ?? null } : { state: 'unknown', message: null },
    };
  }

  const sameUser = (a, b) => (a === b) || (!!a && !!b && a.uid === b.uid && a.sid === b.sid
    && a.email === b.email && a.displayName === b.displayName
    && a.profile.state === b.profile.state && a.profile.message === b.profile.message);

  // What this build can do for a given identity. Hosted (original MeetMemo web service)
  // capabilities are never granted by a local login.
  function capabilities(user) {
    return {
      localSync: !!user, // save Google Meet captions to the local backend
      transcripts: !!user, // view saved transcripts (transcript.html)
      hostedAI: false,
      hostedBilling: false,
      hostedSharing: false,
      hostedSettings: false,
    };
  }

  // Calls cb(user|null) now and on every identity change (login, logout, account switch,
  // profile state change, removal by the worker). Token refreshes do not trigger callbacks.
  // A storage change that lands while the initial read is pending wins over that read, so a
  // late initial load can never overwrite newer state. Returns an unsubscribe function.
  function subscribe(cb, chromeApi = self.chrome) {
    let active = true;
    let changes = 0;
    let last; // undefined until the first emit
    const emit = (raw) => {
      if (!active) return;
      const user = toUser(raw);
      if (last !== undefined && sameUser(last, user)) return;
      last = user;
      cb(user);
    };
    const onChanged = (c, area) => {
      if (area !== 'local' || !(KEY in c)) return;
      changes += 1;
      emit(c[KEY].newValue);
    };
    chromeApi.storage.onChanged.addListener(onChanged);
    const seen = changes;
    chromeApi.storage.local.get(KEY).then((r) => { if (changes === seen) emit(r[KEY]); }, () => {});
    return () => {
      active = false;
      chromeApi.storage.onChanged.removeListener(onChanged);
    };
  }

  async function currentUser(chromeApi = self.chrome) {
    return toUser((await chromeApi.storage.local.get(KEY))[KEY]);
  }

  // Sync status is stored per identity; anything recorded for another uid/session is ignored.
  function statusFor(status, user) {
    return status && user && status.uid === user.uid && status.sid === user.sid ? status : null;
  }

  self.MeetMemoSession = { KEY, STATUS_KEY, sidOf, toUser, sameUser, capabilities, subscribe, currentUser, statusFor };
})();

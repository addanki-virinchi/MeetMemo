// Explicit routing for the bundled UIs' hosted-app links and sign-in prompts.
//
// The bundles (content.js panel, options.js) were built for a hosted web app that does not
// exist in this build. Narrow patches send their URL helper (content.js gn / options.js aa)
// and sign-in function (content.js Za / options.js Vw) here. Only destinations the local
// build implements are mapped to real pages; hosted-only features open unavailable.html,
// which says so plainly instead of pretending the navigation worked.
//
// Inventory of callers (bundle anchor -> path/source -> destination):
//   gn("/auth...") inside Za, aa("/auth") inside Vw .......... -> auth.html (sign in)
//   gn(VAe) "View transcript list", aa(xte) .................. "/transcripts" -> auth.html (recent meetings)
//   gn("") share-link base / markdown check, aa("") / aa("/") . "" or "/" -> auth.html (local home)
//   aa("/welcome...") after granting permissions ............. -> auth.html
//   gn(`/transcripts/${hostedId}`) GDoc buttons, post-meeting . -> unavailable: hosted-transcript
//   gn(jAe) "/settings", "/settings/general", "/settings/tags" -> unavailable: settings
//   gn(KP) / gn("/billing") / aa(bte) Upgrade buttons ......... -> unavailable: billing
//   aa(Ite) "/invite" ......................................... -> unavailable: invite
//   anything else ............................................. -> unavailable: hosted
//   Za("share-button") ........ -> this meeting's saved transcript (via sync/content.js)
//   Za("screenshot-button"), Za("minimised-screenshot-button") -> unavailable: screenshots
//   Vw("unsaved-transcript") .. -> unavailable: unsaved-transcripts
//   Za/Vw other sources (widget-header, transcript-notification, must-relogin-popover,
//   sign-up-popover, options-page) -> sign-in window (auth.html)
//
// Classic script. In content scripts, sync/content.js provides self.MEETMEMO_SYNC for Share.
(() => {
  const page = (p) => chrome.runtime.getURL(p);
  const unavailable = (feature) => page(`unavailable.html?feature=${encodeURIComponent(feature)}`);

  function appUrl(path) {
    const p = String(path ?? '').split(/[?#]/)[0];
    if (p === '' || p === '/' || p === '/auth' || p === '/transcripts' || p === '/welcome') return page('auth.html');
    if (p.startsWith('/transcripts/')) return unavailable('hosted-transcript');
    if (p === '/settings' || p.startsWith('/settings/')) return unavailable('settings');
    if (p === '/billing' || p.startsWith('/billing/')) return unavailable('billing');
    if (p === '/invite') return unavailable('invite');
    if (p === '/help' || p.startsWith('/help/')) return unavailable('help');
    return unavailable('hosted');
  }

  const HOSTED_ONLY_SOURCES = {
    'screenshot-button': 'screenshots',
    'minimised-screenshot-button': 'screenshots',
    'unsaved-transcript': 'unsaved-transcripts',
    // Ask MeetMemo AI while a local account is signed in: AI is hosted-only, so explain that
    // instead of showing the hosted "Signed out" popover to someone who is signed in.
    'ask-ai': 'ai',
  };

  function send(msg) {
    try {
      chrome.runtime.sendMessage({ type: 'meetmemo-open', ...msg }).catch?.(() => {});
    } catch (err) {
      console.warn('[MeetMemo] extension was reloaded; refresh this page', err);
    }
  }

  function signIn(source) {
    const feature = HOSTED_ONLY_SOURCES[source];
    if (feature) return send({ target: 'unavailable', feature });
    if (source === 'share-button' && self.MEETMEMO_SYNC) return self.MEETMEMO_SYNC.openTranscript();
    return send({ target: 'signin' });
  }

  // Hard-coded help-site links in the bundles (help.MeetMemo.io, MeetMemo.io/help/...). Opened
  // by the service worker so it also works where unavailable.html is not web-accessible.
  function openHelp() {
    send({ target: 'unavailable', feature: 'help' });
    return null;
  }

  self.MEETMEMO_LINKS = { appUrl, signIn, openHelp, HOSTED_ONLY_SOURCES };
})();

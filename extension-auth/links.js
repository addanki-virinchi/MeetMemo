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
//   gn(VAe) "View transcript list" (panel Home), aa(xte) ...... "/transcripts" -> history.html (transcription history)
//   gn("") share-link base / markdown check, aa("") / aa("/") . "" or "/" -> auth.html (local home)
//   aa("/welcome...") after granting permissions ............. -> auth.html
//   gn(`/transcripts/${hostedId}`) GDoc buttons, post-meeting . -> unavailable: hosted-transcript
//   gn(jAe) "/settings", "/settings/general", "/settings/tags" -> settings.html (panel gear)
//   YP "/help" (panel "?"), openHelp() for hard-coded help links -> help.html
//   "/privacy", openPage("privacy") from the panel privacy popover -> privacy.html
//   gn(KP) / gn("/billing") / aa(bte) Upgrade buttons ......... -> unavailable: billing
//   aa(Ite) "/invite" ......................................... -> unavailable: invite
//   anything else ............................................. -> unavailable: hosted
//   Za("share-button") ........ -> this meeting's saved transcript (via sync/content.js)
//   Za("ask-ai") .............. -> this meeting's transcript with Ask Meet Memo open (via sync/content.js)
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
    if (p === '' || p === '/' || p === '/auth' || p === '/welcome') return page('auth.html');
    if (p === '/transcripts') return page('history.html');
    if (p.startsWith('/transcripts/')) return unavailable('hosted-transcript');
    if (p === '/settings' || p.startsWith('/settings/')) return page('settings.html');
    if (p === '/privacy') return page('privacy.html');
    if (p === '/billing' || p.startsWith('/billing/')) return unavailable('billing');
    if (p === '/invite') return unavailable('invite');
    if (p === '/help' || p.startsWith('/help/')) return page('help.html');
    return unavailable('hosted');
  }

  const HOSTED_ONLY_SOURCES = {
    'screenshot-button': 'screenshots',
    'minimised-screenshot-button': 'screenshots',
    'unsaved-transcript': 'unsaved-transcripts',
    // The Claude tab while a local account is signed in: AI is hosted-only, so explain that
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
    // The Claude tab in the meeting panel: open this meeting's transcript with the Ask Meet Memo
    // panel focused. Outside a meeting tab (no MEETMEMO_SYNC) it falls through to the
    // explanation page below.
    if (source === 'ask-ai' && self.MEETMEMO_SYNC) return self.MEETMEMO_SYNC.openTranscript({ ask: true });
    const feature = HOSTED_ONLY_SOURCES[source];
    if (feature) return send({ target: 'unavailable', feature });
    if (source === 'share-button' && self.MEETMEMO_SYNC) return self.MEETMEMO_SYNC.openTranscript();
    return send({ target: 'signin' });
  }

  // Opens one of the extension's own pages (history, settings, help, privacy) in a new tab via
  // the service worker, so it works from any context, including Meet pages.
  const PAGES = ['history', 'settings', 'help', 'privacy'];
  function openPage(name) {
    if (PAGES.includes(name)) send({ target: 'page', page: name });
    return null;
  }
  // Hard-coded help-site links in the bundles (help.MeetMemo.io, MeetMemo.io/help/...).
  const openHelp = () => openPage('help');

  self.MEETMEMO_LINKS = { appUrl, signIn, openPage, openHelp, PAGES, HOSTED_ONLY_SOURCES };
})();

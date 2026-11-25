# MeetMemo meeting transcription: repository logic

> Deploying to Render, Google sign-in setup and the end-to-end checklist: see [DEPLOYMENT.md](./DEPLOYMENT.md).

## Local testing (sign-in and transcript saving)

The bundled UI's own sign-in goes to a hosted web app (`app.MeetMemo.io`) that is not part
of this repo, so the extension uses a local auth + sync layer instead:

| File | Role |
| --- | --- |
| `auth.html` / `auth.js` | Toolbar popup: sign in, create account, profile-setup errors with Retry, per-meeting sync status, recent meetings (Show more) |
| `history.html` / `history.js` | Transcription history: meetings grouped by day with title/code, date, time, duration and a short preview; search, open, delete |
| `transcript.html` / `transcript.js` | Private, read-only transcript reader (all pages; follows sign-in changes; `?live=1` follows saving). Copy, download .txt, print/PDF, and on-device "Read in" translation via Chrome's built-in `Translator` (never changes the saved text) |
| `settings.html` / `settings.js` | Account, transcription-language guidance, reading language, Ask AI answer language (saved for later), data links, server check. Prefs in `chrome.storage.local.meetmemo_prefs` |
| `help.html` / `help.js` | Getting started, panel controls, languages, troubleshooting, copyable diagnostics (no transcript text or tokens) |
| `privacy.html` | What is saved, where, who can see it, retention and deletion |
| `ui/pages.css`, `ui/format.js` | Shared styles (light/dark, print) and display helpers + preferences for the pages above |
| `extension-auth/panelPrivacy.js` | Content of the panel's Privacy (shield) popover |
| `unavailable.html` / `unavailable.js` | Explains features this version does not provide (billing, screenshots, Ask AI "coming soon", …) |
| `extension-auth/session.js` | Shared identity helpers: `subscribe` (cross-context login/logout/switch), `toUser` (no tokens), `statusFor`, capabilities |
| `extension-auth/sessionAuthority.js` | Service worker only: the single writer of the session (login commit, logout, token refresh, profile state) |
| `extension-auth/manualAuthProvider.js` | Page-side provider (email/password and Google sign-in via the backend `/v1/auth` routes); talks to the authority over the `meetmemo-auth` port |
| `extension-auth/apiClient.js` | Backend client: timeouts, `expectUid` guard, paginated `listAllSegments` |
| `extension-auth/localBridge.js` | `MEETMEMO_LOCAL_AUTH` for the bundled panel/options (local identity only) |
| `extension-auth/links.js` | `MEETMEMO_LINKS`: explicit routing table for the bundles' hosted links and sign-in prompts |
| `sync/content.js` | On Meet: tracks caption revisions, respects Pause, hands lines to the worker's durable queue |
| `sync/worker.js` | Durable per-account queue, meeting mapping, single upload loop with retries, scoped status |
| `sync/segment-id.js` | Segment document ids (`m2_` + 128-bit SHA-256 prefix; legacy scheme for old meetings) |
| `service-worker.js` | Loads the bundled `background.js` plus the files above |
| `meetmemo.config.js` | API base URL shared by pages and the worker |

One-time Firebase setup (project `meetmemo-c7576`):

1. Firebase Console → **Build → Firestore Database → Create database** (any region).
2. Firebase Console → **Build → Authentication → Sign-in method** → enable **Email/Password**.
3. Deploy the composite index used by the meetings list:
   `npx firebase-tools deploy --only firestore:indexes,firestore:rules` (from `backend/`).
   Without it the popup's "Recent meetings" errors; saving still works.

Run it:

1. `cd backend && npm install`, then start the API:
   `npx cross-env NODE_ENV=development node src/server.js` (needs real Firebase credentials and
   `FIREBASE_WEB_API_KEY` in `backend/.env.development`). Check `http://localhost:8080/healthz`.
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
   The extension id must be `gnolicpkknhchlmmfgamghnjcbmpndlf` (it matches `ALLOWED_ORIGINS`).
3. Click the toolbar icon → **Create account** (any email, password ≥ 8 characters).
4. Join a Google Meet call, open the MeetMemo panel and let captions run. Each line is saved
   within a few seconds; the popup shows "Saving (abc-defg-hij)…".
5. Popup → **Recent meetings** → open the meeting to see the saved transcript.

After editing extension files, press **Reload** on `chrome://extensions` and refresh the Meet tab.

### Accounts and sessions

* One local session (`chrome.storage.local.meetmemo_session`) is shared by the popup, the
  in-meeting panel, the options page, the transcript viewer and the worker. Only the service
  worker writes it (`sessionAuthority.js`). Every write is serialized and checked against the
  per-login session id, so a token refresh still in flight during logout or an account switch
  is discarded instead of restoring the old account. Concurrent refreshes share one request. A
  backend that is down keeps the session; a rejected refresh token ends only that session.
* Every open page re-renders on login, logout, account switch or removal by the worker
  (`chrome.storage.onChanged`), without reloading.
* Profile setup (`POST /v1/users/me`) is tracked separately from sign-in. A failure is shown in
  the signed-in popup with **Retry**.
* Local sign-in is **not** a hosted MeetMemo sign-in. The bundled panel keeps its original
  hosted account state. The bridge only hides its sign-in prompts (header button, orange "not
  saved" banner, save-status tooltip, the "Signed out" relogin popover and the "Sign Up to save
  your transcripts" popover) while a local account is signed in. Hosted features stay
  unavailable and say so (Ask MeetMemo AI opens `unavailable.html?feature=ai`).

### Render only: no hosted MeetMemo hosts

* The only API host is the Render service in `meetmemo.config.js` / `host_permissions`.
* The bundles still contain the original hosted URLs (`api2.MeetMemo.io`, `app.MeetMemo.io`,
  `help.MeetMemo.io`). They are never navigated to: the install tab opens `auth.html` (was
  `api2.MeetMemo.io/api/2/u/welcome/…`), the uninstall URL is cleared (was
  `api2.MeetMemo.io/api/2/u/uninstall/…`), and help links open `unavailable.html?feature=help`.
* The same ruleset blocks the bundles' leftover analytics (`mixpanel.com`, `browser-intake-datadoghq.com`), but only
  for requests made by the extension itself or by Meet/Teams/Zoom pages, never the rest of the browser.
* As a safety net, the static ruleset `rules/block-hosted.json` blocks every request to
  `meetmemo.io` and its subdomains, including page navigations.

### Local sync (Google Meet only, chat excluded)

* Each caption id's highest accepted revision is remembered. Older revisions are ignored; an
  equal revision with identical text is a duplicate; an equal revision with new text is
  accepted. The backend enforces the same rule: a stored higher `rev` is never replaced.
* Lines are handed to the worker about once a second. The worker writes them to a durable queue
  (`meetmemo_q:<tabSession>:<uid>`) **before** acknowledging. Upload to the backend happens
  afterwards in a single loop, with timeouts, backoff, a one-minute alarm and a retry at worker
  start-up. Closing a tab loses at most the last second of captions.
* Ownership: queued lines belong to the account signed in when they were received and are
  uploaded only with that account's token. Lines captured while signed out are saved to the next
  account that signs in. Lines held for a different account wait up to 7 days for it to sign in.
* The queue holds at most 5,000 unsaved lines per meeting tab. Overflow drops the oldest lines
  and the popup reports how many were dropped.
* Pause and auto-pause: while the panel's transcript is paused, captions are not saved. The
  panel itself also drops them.
* Status (`meetmemo_sync_status`) records the uid and session id; status from another account or
  session is never shown. It is cleared on logout and on login.

### Compatibility decisions

* **Segment ids.** New meetings (`segmentIdScheme: 2`) use `m2_` plus the first 32 hex characters
  of SHA-256 over the caption id, and store the original id as `sourceId`. Meetings that the
  previous version already mapped in an open tab session keep the old lossy ids (`/` → `_`, cut
  at 200 characters), so lines re-sent after upgrading do not duplicate. The old collision risk
  remains for those meetings only. Existing segment documents are not rewritten.
* **Revisions.** `rev` is optional. Segments without it (old data, old clients) count as "no
  revision", so any new write replaces them, as before. No migration is needed.
* **Pagination.** `GET /v1/meetings/:id/segments?limit=1..1000&after=<cursor>` orders by
  `(ts, document id)` and returns `{ items, next }`, where `next` is null on the last page. An
  invalid `limit` or `after` returns 400. Only single-field ordering is used (no new composite
  index).
* **Old mapping storage.** The previous `storage.session.meetmemo_sync_meetings` object is
  migrated once to per-account keys (`meetmemo_map:<uid>:<tabSession>`).

### In-meeting panel routing

| Panel control | Opens |
| --- | --- |
| Sign In (header, banner, relogin/sign-up popovers) | `auth.html` sign-in window |
| Share | This meeting's private transcript (`transcript.html?id=…&live=1`) after pending lines are durably queued; the sign-in window if signed out. Tooltip relabelled in `lang/en.json` (`juDfTR`) |
| Home (View transcript list) | `history.html` |
| Settings (gear) / tags / notifications | `settings.html` |
| Help (?) and hard-coded help links | `help.html` |
| Privacy (shield) popover | Local answers from `panelPrivacy.js`; "Read the full privacy information" opens `privacy.html` |
| Upgrade / billing | `unavailable.html?feature=billing` |
| Screenshot buttons | `unavailable.html?feature=screenshots` |
| Hosted transcript links (`/transcripts/<hostedId>`) | `unavailable.html?feature=hosted-transcript` |
| Options page: Sign In / My MeetMemo / logo / Continue | `auth.html`. Save on an unsaved transcript opens `unavailable.html?feature=unsaved-transcripts` |

### Bundle bridge (no original source or build pipeline in this repo)

The production bundles are edited only at these anchors. Each is present exactly once, which
`tests/viewer-routing.test.mjs` checks.

* `content.js`:
  * `function Za(e){` (sign-in) calls `MEETMEMO_LINKS.signIn`.
  * `function gn(e){` (hosted URL) calls `MEETMEMO_LINKS.appUrl`.
  * `Fl=()=>{…nt(e)…}` exposes `MEETMEMO_PANEL.currentTranscript`. It is read-only and used for Pause.
  * `showLoginButton:!e?.id` and `o=W(rm)` (the banner) use `MEETMEMO_LOCAL_AUTH.showSignIn`.
  * The `Zdk4lf` save-status tooltip text.
  * `u?.mustRelogin` (`X7`, "Signed out") and `u?.mustSignUp` (`NY`, "Sign Up") are wrapped in
    `MEETMEMO_LOCAL_AUTH.hostedPrompt`, which renders nothing while a local account is signed in.
  * Both Ask AI `n($L())` calls route to `MEETMEMO_LINKS.signIn("ask-ai")` when signed in locally.
  * `var YP=` and the hosted help `window.open(...)` calls use `MEETMEMO_LINKS.appUrl("/help")` / `openHelp()`.
  * The privacy popover's `o2I5Fb` `<dd>` is replaced by `MEETMEMO_PANEL_PRIVACY.items(ye.default)`; the "Notify in chat"
    message no longer contains a `MeetMemo.io` link.
* `background.js`: the install welcome tab opens `auth.html`; `setUninstallURL("")`.
* `options.js`:
  * `function Vw(e){` and `function aa(e){` use the same routing.
  * The two `window.open("https://help.MeetMemo.io")` calls use `MEETMEMO_LINKS.openHelp()`.
  * The `uie` header shows the local account.
  * `BB` hides the "not signed in" warning when a local account is signed in.
* `options.html` loads `extension-auth/session.js`, `localBridge.js` and `links.js` before `options.js`.

### Tests

* Extension: `node --test "tests/*.test.mjs"`, run from this folder. The tests run the real
  files in isolated VM contexts with fake storage, ports, auth and backend. No browser or
  account is used.
* Backend: `cd backend && npm test`. Route tests run against an in-memory Firestore fake.

### Limitations

* Not verified in a live browser: login, panel/popup/options agreement, Meet capture, Pause,
  transcript open/copy. Run the steps above before relying on any of it.
* The panel still shows some hosted-only state: the save-status icon stays orange. The hosted
  relogin/sign-up popovers appear only while no local account is signed in. AI, hosted sharing
  links, billing, screenshots and hosted autosave need the original hosted service.
* Tokens remain in `chrome.storage.local`, which content scripts can technically read. The
  authority refuses to hand tokens to content scripts.
* Google sign-in and the Render deployment are documented in [DEPLOYMENT.md](./DEPLOYMENT.md);
  neither has been exercised against a live Google account or browser from this repo's tests.

## Purpose and scope

This repository is the packaged browser extension for MeetMemo. Its primary
job is to place a MeetMemo interface inside supported meeting pages and feed
meeting text into that interface while the meeting is running. The extension
supports Google Meet directly and contains platform adapters for Microsoft
Teams and Zoom.

This document explains the logic that can be reconstructed from the shipped
files. It is intentionally an implementation guide rather than a product
claim. Most JavaScript files are production bundles: they are minified,
name-mangled, and contain embedded React, Firebase, analytics, protobuf, and
other library code. The exact original source-module boundaries are therefore
not present in this snapshot. The behavior described below is based on
observable entry points, URLs, event names, data structures, diagnostics, and
platform-specific code in the bundles.

## 1. Extension architecture

### Manifest and execution contexts

[`manifest.json`](./manifest.json) is the runtime map:

* `background.js` is the Manifest V3 service worker.
* `content.js` is loaded into Google Meet pages and owns the extension UI and
  page-facing orchestration.
* `rtcinjector.js` is loaded at `document_start`. It runs early enough to place
  page-context adapter scripts before the meeting application has initialized.
* `googlemeet.inline.js`, `msteams.inline.js`, and `zoom.inline.js` are made
  web-accessible so the injector can add them to the host page.
* `popup.html`/`popup.js` and `options.html`/`options.js` provide extension
  controls and settings.
* `lang/*.json` and `_locales/*/messages.json` contain localized UI strings.

The extension requests `storage`, `unlimitedStorage`, `alarms`, `scripting`,
`activeTab`, `declarativeContent`, and `declarativeNetRequest`. It has a
specific Google Meet host permission and optional broad host permissions. The
specific permission is enough for the normal Meet content-script path; the
optional permissions allow other integrations to be enabled when the user
grants access.

The separation into content scripts and inline scripts is important. A normal
extension content script has an isolated JavaScript world. It cannot reliably
replace a host application's `fetch`, `XMLHttpRequest`, or WebRTC objects.
The inline adapters are inserted as ordinary page scripts, so they can observe
and modify the meeting application's own network and RTC objects. The
extension then uses DOM events as a bridge back to the content-script world.

### Startup sequence

`rtcinjector.js` first classifies the current page:

1. Google Meet is recognized by `meet.google.com` and a meeting path such as
   `abc-defg-hij`, or by the `/new` route.
2. Microsoft Teams is recognized by the Teams host regular expression.
3. Zoom is recognized by the Zoom host regular expression.

If the relevant document head is not ready, the injector waits with a
`MutationObserver`. It inserts the platform adapter with
`chrome.runtime.getURL(...)`, which lets the browser load the extension file
in page context. For Zoom, the injector waits until a host script containing
`redux.min.js`, `externals.min.js`, or `externals.0.min.js` exists, then places
`zoom.inline.js` immediately after it. This ordering is a compatibility
measure: the adapter expects Zoom's application bundles and state to have been
created.

The adapters initialize a shared `window.MeetMemortc` object. They set a
`contentScriptReady` flag when the content script announces readiness and
flush any diagnostic messages queued before that point. This avoids losing
startup failures while the meeting page is still loading.

## 2. Common capture pipeline

Although the platform mechanisms differ, the logical pipeline is the same:

```text
meeting application
        |
        | native captions, internal API responses, or RTC data
        v
platform inline adapter
        |
        | normalized event/message bridge
        v
content.js + MeetMemo widget
        |
        | transcript blocks, speaker/language state, actions
        v
local/session persistence and MeetMemo web services
```

The extension is not a generic microphone recorder in the inspected code. The
transcription path is based on text already produced by the meeting platform
or on the platform's own caption transport. In particular, the Google Meet
adapter defines a protobuf `BTranscriptMessage` with `deviceId`,
`messageId`, `messageVersion`, `text`, and `langId`. That is evidence of
capturing structured caption messages rather than sending raw microphone audio
to a browser `MediaRecorder`.

The widget also exposes controls for pause/resume, caption visibility,
language changes, screenshots, highlights, sharing, and AI questions. The
English localization catalog documents the expected states: paused
transcription, unsaved transcripts, autosave, sign-in requirements, language
switching, sharing, and AI credit limits. The UI can therefore display a live
transcript before a user has signed in, while saving and cloud features depend
on account state and product limits.

## 3. Google Meet capture logic

Google Meet is the most technically complete adapter in this snapshot. It
does not scrape only the visible caption DOM. Instead, it attaches to Meet's
media-session and RTC caption channel.

### 3.1 Obtaining the media session

[`googlemeet.inline.js`](./googlemeet.inline.js) declares the Meet endpoints it
needs to observe:

* `.../media_sessions/modify`
* `.../media_sessions/query`
* `.../MeetingSpaceService/SyncMeetingSpaceCollections`
* the meeting-message endpoint
* the media-session creation endpoint

The adapter monkey-patches both `XMLHttpRequest.open`/`send` and
`window.fetch`. When a request URL matches a known endpoint, it records the
request or response and extracts identifiers from the body. The diagnostics
call this phase `MediaSessionCapture` and report events such as “Meet session
acquired,” “createMeetingDevice,” and “queryCaptionLanguage.”

The session identifier is needed to address the correct Meet media session.
The adapter also extracts device identifiers and maps them to device names.
This mapping is used later to associate a transcript message with a speaker
or participant when Meet supplies enough metadata.

### 3.2 Opening the caption data channel

Once the media session and the page's peer connection are available, the
adapter creates or adopts a WebRTC data channel dedicated to captions. The
diagnostic phases show the intended state machine:

1. `StartingCaptions` begins and waits for the peer connection.
2. The adapter opens or discovers the caption channel.
3. It sends the required caption configuration and language.
4. `ChannelHealth` marks the channel healthy.
5. Incoming caption packets are decoded and emitted as parsed events.

The implementation handles several real-world races:

* If the peer connection is delayed, it logs a five-second warning rather than
  immediately failing.
* If Meet itself opens the caption channel, the adapter subscribes to it.
* If multiple caption channels appear, it adopts the newer valid channel.
* If a channel closes, it attempts to reopen it.
* After a reopen, it resends the selected caption language.
* If caption traffic becomes silent, it requests captions again and attempts
  recovery.

The adapter reports explicit failure states including “captions channel did
not open” and “RTC connection failed to initialise.” These states explain why
the UI can say that transcription is unavailable even though the meeting page
itself is still usable.

### 3.3 Decoding transcript messages

Meet messages are binary. The bundle includes protobuf reader/writer code and
the `MeetMemoGoogleMeet` message namespace. The central transcript record is
`BTranscriptMessage`; its wrapper carries the transcript message object.

At a high level, each incoming packet is:

1. read from the caption data channel;
2. decoded using the protobuf schema;
3. checked for message identity/version and language;
4. associated with a device or participant when possible;
5. converted into a `MeetMemo-captions-parsed` custom event;
6. consumed by the extension UI and transcript state.

The message version and message ID allow the adapter to distinguish updates
from entirely new caption blocks. This matters because live captions are often
interim: a speaker's current sentence may be revised several times before it
is final. The transcript UI can therefore update the current block instead of
appending every partial packet as duplicate text.

### 3.4 Language handling

The adapter observes Meet's caption-language query and configuration requests.
It can rewrite outgoing caption configuration to the requested language and
can send language control packets over the media-session channel. The
`LanguageApi` and `LanguageGuard` diagnostics show that language changes are
treated as a guarded operation rather than an unconditional mutation.

If a language request cannot be sent through the data channel, the adapter
reports `setViaDataChannelFailed`. On successful changes it emits a
`language-changed` event. The UI strings in [`lang/en.json`](./lang/en.json)
describe the corresponding user experience: “Change transcription language,”
“Switched to {language},” and the option to use the new language next time.

## 4. Microsoft Teams capture logic

The Teams adapter is [`msteams.inline.js`](./msteams.inline.js). Its approach
is different from Meet's dedicated protobuf caption channel.

The bundle contains Teams websocket handling, XMLHttpRequest interception, and
an API construction for:

```text
https://api.flightproxy.teams.microsoft.com/api/v2/ep/{endpoint}/v2/oncommand/{...}
```

This indicates that the adapter observes Teams' internal meeting/session
traffic and uses the same authenticated browser context to request or receive
meeting data. It also contains response parsing and custom events for
communication with the content layer.

The practical flow is:

1. wait for the Teams page and its runtime objects;
2. identify the active meeting/session and the relevant endpoint;
3. observe websocket or XHR traffic used by the Teams client;
4. parse caption/transcript payloads when they arrive;
5. normalize them into MeetMemo events;
6. let the widget render and persist them.

Teams has more server/API variability than Meet, so the extension includes
explicit failure text: “Something went wrong with Microsoft Teams. Please try
rejoining the meeting to get the transcription working again.” This is
consistent with an adapter that depends on internal request shapes and
session state instead of a stable public transcript API.

The repository does not expose a clean TypeScript model for the Teams payloads;
the shipped bundle is the source of truth. Consequently, this documentation
does not claim that every Teams meeting exposes the same transcript fields.
Speaker identity, language, and finalization behavior depend on what the
current Teams client sends to the adapter.

## 5. Zoom capture logic

[`zoom.inline.js`](./zoom.inline.js) is smaller and uses a lighter bridge. It
installs a MeetMemo UI/event layer and listens for the host application's
transcript/caption state. The injector deliberately places it after a Zoom
Redux or externals script, which gives it access to the application runtime.

The Zoom implementation checks for live-transcription availability and emits
custom events back to the extension. The localization catalog describes the
important prerequisite: the meeting host must have enabled Live
Transcription, and the extension cannot start when that capability is absent.
The adapter also exposes caption visibility and transcription language
controls where Zoom makes them available.

Unlike the Google Meet adapter, the inspected Zoom bundle does not show a
protobuf transcript schema or a direct WebRTC caption data-channel
implementation. The safest interpretation is that it reads/coordinates with
Zoom's existing live-transcription state and forwards the resulting text.
This is why Zoom transcription is dependent on host settings and why rejoining
or enabling the host feature can be required.

## 6. Event and UI integration

The platform scripts cannot directly render the React widget in the isolated
extension world, so they use DOM-level custom events. Names visible in the
bundles include `MeetMemo-message`, `MeetMemo-content-ready`,
`MeetMemo-captions-parsed`, and a chat-send result event.

The general bridge is:

1. the page adapter calls `document.documentElement.dispatchEvent(...)` with
   a `CustomEvent`;
2. the content script listens for the event and translates its `detail`;
3. the React application updates transcript, speaker, language, and status
   state;
4. UI actions are sent back through the same bridge or through extension
   messaging;
5. the adapter performs the platform-specific action and reports success or
   failure.

The content UI is packaged in [`content.js`](./content.js), while the popup
and settings experiences are packaged in [`popup.js`](./popup.js) and
[`options.js`](./options.js). These files include the React application,
transcript rendering, account flows, AI interactions, sharing controls, and
analytics/library code in addition to the transcription logic.

Visible product behavior supported by the localization files includes:

* live transcript rendering;
* pause and resume;
* automatic saving and unsaved-meeting recovery;
* sign-in prompts before cloud persistence;
* language switching;
* screenshots and highlights attached to the transcript;
* meeting sharing by link or email;
* summaries, action items, follow-up questions, and “Ask MeetMemo AI”;
* participant notification prompts explaining that transcription is active.

These features are downstream of capture. If no caption event reaches the
content layer, the UI can still load but it cannot produce transcript blocks.

## 7. Persistence, privacy, and limits

The manifest grants browser storage and unlimited extension storage, and the
UI has explicit “unsaved transcript” and autosave states. This suggests a
two-stage model:

1. keep the current meeting transcript locally or in in-memory application
   state while capture is active;
2. synchronize it to MeetMemo's web application when the user is signed in
   and saving is allowed.

The exact persistence keys and backend request contracts are hidden inside the
bundled React/Firebase code; no standalone database schema is present in this
repository. The localization strings make the product contract explicit:
meetings are private by default, signing in is required to save meeting
transcripts, and account/plan limits can prevent saving or AI analysis.

The extension does not appear to record a raw audio file in the examined
capture adapters. It captures platform-produced text or caption transport.
That distinction should be preserved in security and privacy reviews: transcript
text is still sensitive meeting content, and the extension has permission to
observe the relevant meeting pages and communicate with MeetMemo services.
Participants are prompted or notified through the UI strings, but compliance
with local recording and consent laws remains an operational responsibility.

## 8. Failure modes and troubleshooting

The diagnostic names provide a useful troubleshooting checklist:

### No transcript appears

* Confirm the meeting platform and URL are supported.
* Confirm the host has enabled live captions/transcription where required.
* Confirm the content script and platform adapter were injected.
* For Meet, check that a media session was captured and the caption channel
  became healthy.
* For Teams, rejoin if its internal endpoint/session state changed.
* For Zoom, verify host Live Transcription is enabled.

### Transcript starts and then stops

* Meet may have closed its data channel; the adapter should attempt reopen and
  language resend.
* A peer connection replacement can make the old channel stale.
* A page update can invalidate internal Teams or Zoom object references.
* The extension may be paused from the widget.

### Transcript is visible but is not saved

* The user may not be signed in.
* The meeting may have reached a free-plan or AI-credit limit.
* The browser may have blocked the optional host permission or network
  request.
* The UI's unsaved-meeting recovery path should be used before closing the
  meeting tab.

## 9. Important implementation caveats

This snapshot is a distribution artifact, not a maintainable source tree:

* JavaScript is largely minified and lacks stable source line names.
* Several large bundles contain third-party libraries and product code mixed
  together.
* There are no visible unit or integration tests for transcript capture.
* Platform integrations rely on private or changing host-page behavior.
* The exact backend persistence protocol cannot be reliably documented from
  localization strings alone.

For future maintenance, the safest design would be to extract each adapter
into readable modules with typed normalized events, document the event schema,
add fixture-based tests for Meet protobuf packets and Teams/Zoom payloads, and
keep the capture state machine separate from React rendering. A normalized
record should at minimum preserve meeting ID, platform, timestamp, speaker or
device identity when available, text, language, interim/final status, and a
stable message ID.

## Summary

MeetMemo captures meeting transcriptions by integrating with each platform's
own caption machinery rather than using one universal audio recorder. The
early injector selects a platform adapter. Google Meet is the deepest
integration: it intercepts media-session requests, obtains the session,
opens/repairs a caption RTC data channel, decodes protobuf transcript
messages, and emits parsed caption events. Teams observes internal websocket
and API traffic, while Zoom coordinates with the host application's live
transcription state. The content-script React application receives normalized
events, renders the live transcript, exposes controls, and manages local
unsaved state plus authenticated cloud-saving and AI features.

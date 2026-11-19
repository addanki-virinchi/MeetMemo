# MeetMemo meeting transcription: repository logic

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

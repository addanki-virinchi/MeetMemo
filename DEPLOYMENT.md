# MeetMemo: deployment and sign-in setup

What gets hosted: **only the backend API** (`backend/`, Express + Firebase Admin → Firestore).
The Chrome extension is loaded in the browser and talks to that API. There is no hosted web app,
so Google OAuth runs through the extension (`chrome.identity`), not through a website.

```
Extension (popup / service worker) ──HTTPS──▶ Render: backend API ──Admin SDK──▶ Firestore
        │  Google OAuth (id_token)                    │ /v1/auth/google → Firebase Auth
        └──────────▶ accounts.google.com              └ verifies Firebase ID token on every call
```

Nothing is tied to Render. The API URL lives in two extension files only, kept in sync by
`node scripts/set-api-url.mjs <url>`.

## 1. Environment variables (backend)

| Variable | Value | Secret? |
| --- | --- | --- |
| `NODE_ENV` | `production` | no |
| `ALLOWED_ORIGINS` | `chrome-extension://gnolicpkknhchlmmfgamghnjcbmpndlf` (comma-separated) | no |
| `FIREBASE_PROJECT_ID` | `meetmemo-c7576` | no |
| `FIREBASE_CLIENT_EMAIL` | service-account email | no |
| `FIREBASE_PRIVATE_KEY` | service-account private key, newlines as `\n` | **yes** |
| `FIREBASE_WEB_API_KEY` | Firebase Console → Project settings → General → Web API Key | no (public) |
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth client id from step 3 | no (public) |
| `AUTH_PASSWORD_ENABLED` | `true` (default) | no |
| `PORT` | set by Render | no |

No OAuth client **secret** is used anywhere: the extension uses Google's implicit `id_token` flow
and Firebase validates the token, so there is nothing to store. Never commit `.env*` files
(`.gitignore` already excludes them).

## 2. Deploy on Render

1. Push this repo to GitHub (the `origin` remote already points at it).
2. Render → **New → Blueprint** → pick the repo. `render.yaml` defines the service
   (`rootDir: backend`, `npm ci --omit=dev`, `npm start`, health check `/healthz`).
3. Enter the `sync: false` variables when prompted.
4. After deploy, open `https://<service>.onrender.com/readyz`. `{"ok":true,"firestore":"ok"}`
   proves credentials, project id and the Firestore database work end to end. A 503 body names the
   cause (database missing, permission denied, bad key). The same check is logged at start-up.
5. Free instances sleep after ~15 min; the first request then takes ~50 s. The extension's
   timeouts (60 s) and the durable retry queue absorb this, but use the `starter` plan for a
   always-on service.

## 3. Google Cloud Console (needs the Render URL only for your own records)

1. APIs & Services → **OAuth consent screen**: app name, support email, add the
   `openid`, `email`, `profile` scopes (non-sensitive, no verification needed). Publish to
   **Production** if users outside your test list will sign in.
2. Credentials → use the Firebase-created **"Web client (auto created by Google Service)"**
   (or create an OAuth client of type **Web application**; if you create a new one, add its
   client id under Firebase → Authentication → Sign-in method → Google → *Safelist client IDs from
   external projects*).
3. On that client add **Authorized redirect URI**:
   `https://gnolicpkknhchlmmfgamghnjcbmpndlf.chromiumapp.org/`
   (the extension id is pinned by the `key` in `manifest.json`; `chrome.identity.getRedirectURL()`
   returns exactly this). **Authorized JavaScript origins are not needed**, because no web page
   starts the flow, and the Render domain is not an OAuth redirect.
4. Copy the client id into `GOOGLE_OAUTH_CLIENT_ID` on Render.

## 4. Firebase Console

* **Authentication → Sign-in method**: enable **Google** and keep **Email/Password** enabled.
* **Authentication → Settings → Authorized domains**: only needed if a web page ever signs in
  with the Firebase JS SDK. This build does not, so adding the Render domain is harmless but not
  required. 
* **Firestore Database**: create it (Native mode, `(default)`), then from `backend/`:
  `npx firebase-tools deploy --only firestore:rules,firestore:indexes`.
* **Rules**: `firestore.rules` denies every direct client read/write. That is intentional: all
  access goes through the backend (Admin SDK bypasses rules) and every meeting route checks
  `ownerId == token uid`, so clients can't reach another user's data even with the public web API key.
* Service account needs the **Cloud Datastore User** role (the default firebase-adminsdk account has it).

## 5. Point the extension at the deployed API

```
node scripts/set-api-url.mjs https://<service>.onrender.com
```
Then `chrome://extensions` → **Reload**. This updates `meetmemo.config.js` and the manifest
`host_permissions` together. Moving to DigitalOcean later = run the same command with the new URL
(and update `ALLOWED_ORIGINS` only if the extension id changes).

## 6. End-to-end checklist

1. `/readyz` returns ok. Extension popup → **Continue with Google** → account chooser → popup shows you signed in.
2. Close and reopen the popup, restart Chrome: still signed in (tokens are refreshed by the service worker; only a
   rejected refresh token or **Sign out** ends the session).
3. Sign out → **Create account / Sign in** with email + password.
4. Join a Google Meet call, enable captions, speak for a long time: popup shows "Saving…" then "Saved".
5. Leave the meeting; popup → Recent meetings → open it: the full transcript is there (also visible in Firestore:
   `meetings/{id}/segments`).
6. Sign in as a second user: their list is empty, and opening the first user's meeting URL returns "not found".
7. No Upgrade / pricing / credit prompts appear in the panel, popup or options page.

// Local-identity bridge for the bundled UIs (content.js panel, options.js settings page).
//
// The bundles keep their original hosted (Firebase) account state in their own store; that
// state is NOT changed here and local sign-in never pretends the hosted account is signed in.
// Instead a few anchored patches in the bundles ask this object whether a LOCAL account is
// signed in, so they can stop asking the user to sign in for things the local build does
// (saving Google Meet transcripts) while hosted-only features stay unavailable.
// See README "Bundle bridge" for the exact patch anchors.
//
// Classic script; requires extension-auth/session.js. Defines self.MEETMEMO_LOCAL_AUTH.
(() => {
  const { subscribe } = self.MeetMemoSession;
  let user = null;
  let ready = false;
  const listeners = new Set();
  subscribe((u) => {
    user = u;
    ready = true;
    listeners.forEach((cb) => { try { cb(); } catch (e) { console.error(e); } });
  });

  const api = {
    isSignedIn: () => !!user,
    isReady: () => ready,
    user: () => user,
    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    // React hook: the local user (or null), re-rendering on login/logout/switch.
    useUser(React) { return React.useSyncExternalStore(api.subscribe, api.user); },
    // React hook for the panel's sign-in prompts: show one only if the hosted account is
    // signed out AND no local account is signed in.
    showSignIn(React, hostedSignedOut) {
      const local = api.useUser(React);
      return !!hostedSignedOut && !local;
    },
  };
  self.MEETMEMO_LOCAL_AUTH = api;
})();

import { AuthNotConfiguredError } from './authProvider.js';

// PLACEHOLDER - Google Sign-In is intentionally unimplemented.
// When the SDK is provided, implement these four methods (Firebase Auth web SDK with
// GoogleAuthProvider, or chrome.identity.launchWebAuthFlow + signInWithCredential).
// Keep the signatures identical; nothing else needs to change.
export function createGoogleAuthProvider() {
  const listeners = new Set();
  return {
    async signIn() { throw new AuthNotConfiguredError(); },
    async signOut() { listeners.forEach((cb) => cb(null)); },
    async getIdToken() { return null; },
    onAuthStateChanged(cb) {
      listeners.add(cb);
      cb(null);
      return () => listeners.delete(cb);
    },
  };
}

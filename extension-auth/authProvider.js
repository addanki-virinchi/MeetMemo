// Auth provider contract. The rest of the extension depends only on this shape,
// so swapping in the real Google/Firebase implementation touches one file.
//
// interface AuthProvider {
//   signIn(): Promise<{ uid, email, displayName }>
//   signOut(): Promise<void>
//   getIdToken(forceRefresh?: boolean): Promise<string | null>   // Firebase ID token
//   onAuthStateChanged(cb: (user | null) => void): () => void    // returns unsubscribe
// }

export class AuthNotConfiguredError extends Error {
  constructor() {
    super('Google authentication is not configured yet. Provide the SDK and implement googleAuthProvider.js.');
    this.name = 'AuthNotConfiguredError';
  }
}

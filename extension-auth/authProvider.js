// Auth provider contract. The rest of the extension depends only on this shape,
// so swapping in the real Google/Firebase implementation touches one file.
//
// interface AuthProvider {
//   signIn({ email, password }) / signUp({ name, email, password }) / signInWithGoogle(): Promise<user>
//   signOut(): Promise<void>
//   getIdToken(forceRefresh?: boolean): Promise<string | null>   // Firebase ID token
//   getAuth(forceRefresh?): Promise<{ idToken, user } | null>     // token plus the identity it belongs to
//   getUser(): Promise<user | null>
//   setProfileState(sid, state, message?): Promise<user | null>   // profile setup result for session sid
//   onAuthStateChanged(cb: (user | null) => void): () => void    // returns unsubscribe; fires in every
//                                                                 // open page on login/logout/switch
// user = { uid, sid, email, displayName, profile: { state, message } } (see session.js)
// }

export class AuthNotConfiguredError extends Error {
  constructor() {
    super('Sign-in is not configured.');
    this.name = 'AuthNotConfiguredError';
  }
}

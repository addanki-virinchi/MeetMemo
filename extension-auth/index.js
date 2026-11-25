import { createManualAuthProvider } from './manualAuthProvider.js';
import { createApiClient } from './apiClient.js';

// Public, non-secret settings come from meetmemo.config.js (shared with the service worker).
// Pages must load that file with a plain <script src> before importing this module.
export const settings = {
  apiBaseUrl: 'http://localhost:8080',
  ...self.MEETMEMO_CONFIG,
};

export function createAuthProvider() {
  return createManualAuthProvider({ baseUrl: settings.apiBaseUrl });
}

// Pass the page's provider so the client and the UI share one auth state.
export function createClient(authProvider = createAuthProvider()) {
  return createApiClient({ baseUrl: settings.apiBaseUrl, authProvider });
}

import { createGoogleAuthProvider } from './googleAuthProvider.js';
import { createManualAuthProvider } from './manualAuthProvider.js';
import { createApiClient } from './apiClient.js';

// Public, non-secret settings. Set testMode=false once Google Sign-In is implemented.
export const settings = {
  testMode: true, // keep in sync with backend TEST_MODE
  apiBaseUrl: 'http://localhost:8080', // add to manifest host_permissions when wiring in
};

export function createAuthProvider() {
  return settings.testMode ? createManualAuthProvider({ baseUrl: settings.apiBaseUrl }) : createGoogleAuthProvider();
}

export function createClient() {
  return createApiClient({ baseUrl: settings.apiBaseUrl, authProvider: createAuthProvider() });
}

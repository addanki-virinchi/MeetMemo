// Help page: builds a diagnostic summary for support. Versions and connection state only;
// never transcript text, tokens, passwords or email addresses.
(() => {
  const $ = (id) => document.getElementById(id);

  async function health(base) {
    const started = Date.now();
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(70_000) });
      return `${res.ok ? 'reachable' : `HTTP ${res.status}`} in ${Date.now() - started} ms`;
    } catch (e) {
      return `not reachable (${e?.name || 'error'})`;
    }
  }

  async function collect() {
    const base = self.MEETMEMO_CONFIG?.apiBaseUrl || '(not configured)';
    const local = await chrome.storage.local.get(['meetmemo_session', 'meetmemo_sync_status']);
    const signedIn = !!local.meetmemo_session?.uid;
    const meetings = Object.values(local.meetmemo_sync_status?.meetings || {});
    const states = meetings.reduce((acc, m) => { acc[m.state || 'unknown'] = (acc[m.state || 'unknown'] || 0) + 1; return acc; }, {});
    const lastError = meetings.filter((m) => m.state === 'error').sort((a, b) => b.at - a.at)[0];
    return [
      `MeetMemo extension ${chrome.runtime.getManifest().version}`,
      `Time: ${new Date().toISOString()}`,
      `Browser: ${navigator.userAgent}`,
      `Server: ${base} (${await health(base)})`,
      `Signed in: ${signedIn ? 'yes' : 'no'}`,
      `Recent sync states: ${Object.entries(states).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
      lastError ? `Last sync error: ${lastError.message || 'unknown'}` : null,
      `On-device translation: ${self.Translator ? 'available' : 'not available'}`,
    ].filter(Boolean).join('\n');
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('copy-diagnostics').addEventListener('click', async () => {
      const button = $('copy-diagnostics');
      button.disabled = true;
      $('diag-status').textContent = 'Collecting… (checking the server can take up to a minute)';
      try {
        const text = await collect();
        $('diagnostics').textContent = text;
        $('diagnostics').hidden = false;
        await navigator.clipboard.writeText(text);
        $('diag-status').textContent = 'Copied to your clipboard.';
      } catch (e) {
        $('diag-status').textContent = `Could not copy automatically; select the text below instead. (${e?.message || e})`;
      } finally {
        button.disabled = false;
      }
    });
  });
})();

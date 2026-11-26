// Shared display helpers for the extension pages (history, transcript, popup).
// Classic script: defines self.MeetMemoFormat. No network, no storage.
(() => {
  const PLATFORMS = { googlemeet: 'Google Meet', msteams: 'Microsoft Teams', zoom: 'Zoom' };

  // Firestore timestamps arrive as { _seconds } or { seconds } depending on the SDK version.
  function toDate(t) {
    if (t === null || t === undefined || t === '') return null;
    const s = t.seconds ?? t._seconds;
    const d = typeof s === 'number' ? new Date(s * 1000) : new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Meetings saved by sync/content.js are titled "Google Meet abc-defg-hij — <date>".
  // Show the meeting code as the heading in that case, and a custom title otherwise.
  function meetingHeading(m) {
    const platform = PLATFORMS[m?.platform] || 'Meeting';
    const code = m?.meetingCode || '';
    const raw = String(m?.title || '').trim();
    const generated = !raw || raw === 'Untitled meeting' || /^(Google Meet|Microsoft Teams|Zoom)\s+\S+\s+—\s/.test(raw);
    return { platform, code, title: generated ? (code || 'Untitled meeting') : raw, isCustom: !generated };
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function dayLabel(d, now = new Date()) {
    if (!d) return 'Unknown date';
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (sameDay(d, now)) return 'Today';
    if (sameDay(d, yesterday)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }

  const longDate = (d) => (d ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const time = (d) => (d ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');
  const clock = (d) => (d ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '');

  function duration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 60000) return 'under 1 min';
    const min = Math.round(ms / 60000);
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const rest = min % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  // Stable colour slot (0-5) per speaker name, used as a CSS class suffix.
  function speakerSlot(name) {
    let h = 0;
    for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return h % 6;
  }

  // Languages offered for reading/translating transcripts and for Ask Meet Memo answers.
  // Whether a pair is actually available is checked at runtime (Chrome's on-device Translator).
  const LANGUAGES = [
    ['ar', 'Arabic'], ['bn', 'Bengali'], ['bg', 'Bulgarian'], ['zh', 'Chinese (Simplified)'], ['zh-Hant', 'Chinese (Traditional)'],
    ['hr', 'Croatian'], ['cs', 'Czech'], ['da', 'Danish'], ['nl', 'Dutch'], ['en', 'English'], ['fi', 'Finnish'],
    ['fr', 'French'], ['de', 'German'], ['el', 'Greek'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['hu', 'Hungarian'],
    ['id', 'Indonesian'], ['it', 'Italian'], ['ja', 'Japanese'], ['kn', 'Kannada'], ['ko', 'Korean'], ['lt', 'Lithuanian'],
    ['mr', 'Marathi'], ['no', 'Norwegian'], ['pl', 'Polish'], ['pt', 'Portuguese'], ['ro', 'Romanian'], ['ru', 'Russian'],
    ['sk', 'Slovak'], ['sl', 'Slovenian'], ['es', 'Spanish'], ['sv', 'Swedish'], ['ta', 'Tamil'], ['te', 'Telugu'],
    ['th', 'Thai'], ['tr', 'Turkish'], ['uk', 'Ukrainian'], ['vi', 'Vietnamese'],
  ].map(([code, name]) => ({ code, name }));
  const languageName = (code) => LANGUAGES.find((l) => l.code === code)?.name || code;

  // User preferences shared by the settings page, the transcript reader and Ask Meet Memo.
  const PREFS_KEY = 'meetmemo_prefs';
  const DEFAULT_PREFS = { readingLanguage: '', aiLanguage: '', aiPanelOpen: true };
  async function getPrefs() {
    try {
      const v = (await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY];
      return { ...DEFAULT_PREFS, ...(v && typeof v === 'object' ? v : {}) };
    } catch { return { ...DEFAULT_PREFS }; }
  }
  async function setPrefs(patch) {
    const next = { ...(await getPrefs()), ...patch };
    await chrome.storage.local.set({ [PREFS_KEY]: next });
    return next;
  }

  self.MeetMemoFormat = { PLATFORMS, LANGUAGES, languageName, PREFS_KEY, getPrefs, setPrefs, toDate, meetingHeading, dayLabel, longDate, time, clock, duration, initials, speakerSlot };
})();

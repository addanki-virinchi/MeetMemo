// Explains a hosted-only feature that the local build does not provide (see extension-auth/links.js).
const FEATURES = {
  'hosted-transcript': ['Hosted transcript', 'This link points to a transcript stored in the original hosted MeetMemo service, which this build does not connect to. Transcripts saved by the local build are listed under Recent meetings in the toolbar popup.'],
  settings: ['Account settings', 'Account settings (tags, notifications, recording confirmation) live in the original hosted MeetMemo service, which this build does not connect to.'],
  billing: ['Plans and billing', 'Plans, credits and upgrades belong to the original hosted MeetMemo service, which this build does not connect to.'],
  invite: ['Invites', 'Inviting people belongs to the original hosted MeetMemo service, which this build does not connect to.'],
  screenshots: ['Screenshots', 'Saving screenshots to a transcript needs the original hosted MeetMemo service. The local build saves caption text only.'],
  'unsaved-transcripts': ['Saving older transcripts', 'This list is kept by the original panel, and saving it needs the original hosted MeetMemo service. Meetings captured while you were signed in to the local account were already saved by the local sync; see Recent meetings in the toolbar popup.'],
  ai: ['Ask MeetMemo AI', 'AI answers and summaries need the original hosted MeetMemo service, which this build does not connect to. You are signed in, and your Google Meet transcript is still being saved to your account; see Recent meetings in the toolbar popup.'],
  help: ['Help center', 'The MeetMemo help site belongs to the original hosted MeetMemo service, which this build does not connect to.'],
  hosted: ['Hosted feature', 'This feature needs the original hosted MeetMemo service, which this build does not connect to.'],
};

document.addEventListener('DOMContentLoaded', () => {
  const key = new URLSearchParams(location.search).get('feature');
  const [title, detail] = FEATURES[key] || FEATURES.hosted;
  document.title = `${title} · Not available · MeetMemo`;
  document.getElementById('title').textContent = `${title} is not available in this build`;
  document.getElementById('detail').textContent = detail;
  document.getElementById('open-popup').addEventListener('click', () => {
    chrome.windows.create({ url: chrome.runtime.getURL('auth.html'), type: 'popup', width: 380, height: 640 });
  });
});

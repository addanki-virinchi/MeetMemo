// Explains a feature this version of MeetMemo does not provide (see extension-auth/links.js).
// key: [tab title, heading, explanation]
const FEATURES = {
  'hosted-transcript': ['Old transcript link', 'This transcript link is no longer available', 'It points to a transcript in a previous MeetMemo service that this version does not connect to. Your saved transcripts are all listed under Meetings.'],
  settings: ['Settings', 'These settings are not available', 'Open MeetMemo Settings for the options available in this version.'],
  billing: ['Plans and billing', 'There are no plans or billing', 'This version of MeetMemo has no paid plans or credits.'],
  invite: ['Invites', 'Invites are not available', 'Inviting teammates is not part of this version of MeetMemo.'],
  screenshots: ['Screenshots', 'Screenshots are not available', 'MeetMemo saves caption text only. Screenshots of the meeting are not captured or stored.'],
  'unsaved-transcripts': ['Older transcripts', 'This list is from an earlier version', 'Meetings captured while you were signed in were saved automatically; you will find them under Meetings.'],
  ai: ['Ask MeetMemo AI', 'Ask MeetMemo AI is coming soon', 'Questions, summaries and action items for your meetings are on the way. Your Google Meet transcript is still being saved to your account; you can read it under Meetings.'],
  help: ['Help', 'Looking for help?', 'Open Help for guides and troubleshooting.'],
  hosted: ['Not available', 'This feature is not available', 'It is not part of the current version of MeetMemo.'],
};

document.addEventListener('DOMContentLoaded', () => {
  const key = new URLSearchParams(location.search).get('feature');
  const [tab, heading, detail] = FEATURES[key] || FEATURES.hosted;
  document.title = `${tab} · MeetMemo`;
  document.getElementById('title').textContent = heading;
  document.getElementById('detail').textContent = detail;
  document.getElementById('open-popup').addEventListener('click', () => {
    chrome.windows.create({ url: chrome.runtime.getURL('auth.html'), type: 'popup', width: 380, height: 640 });
  });
});

// Content of the meeting panel's Privacy (shield) popover, replacing the hosted product's
// "configure storage settings at app.MeetMemo.io" answer. content.js calls
// MEETMEMO_PANEL_PRIVACY.items(React) in place of that <dd> (see README "Bundle bridge").
// The returned fragment sits inside the popover's <dl>, after "Where are the transcripts saved?".
//
// Classic content script; requires extension-auth/links.js (MEETMEMO_LINKS.openPage).
(() => {
  const DD = { className: 'my-3 ms-2.5' };
  const DT = { className: 'font-bold' };
  const LINK_STYLE = {
    background: 'none', border: 0, padding: 0, font: 'inherit', cursor: 'pointer',
    color: '#a5b4fc', textDecoration: 'underline',
  };

  function items(React) {
    const h = React.createElement;
    return h(React.Fragment, null,
      h('dd', DD, "In your private MeetMemo account, and only while you're signed in. MeetMemo saves the caption text, speaker names and times. It never records audio or video, and nothing is saved while the panel is paused."),
      h('dt', DT, 'Who can see the transcript?'),
      h('dd', DD, 'Only you. There are no public links: Share opens the transcript for you to copy, download or print.'),
      h('dt', DT, 'Can I delete it?'),
      h('dd', DD, 'Yes. Open your meetings (Home) and delete any meeting permanently.'),
      h('dd', DD, h('button', {
        type: 'button',
        style: LINK_STYLE,
        onClick: () => self.MEETMEMO_LINKS?.openPage('privacy'),
      }, 'Read the full privacy information')));
  }

  self.MEETMEMO_PANEL_PRIVACY = { items };
})();

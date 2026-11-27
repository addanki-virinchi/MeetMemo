// Turns saved segments into the numbered transcript Claude reads, and keeps the mapping from
// line ids (L1, L2, …) back to segment document ids. Line ids are only meaningful inside one
// request: a live meeting gains lines, so answers are stored with segment ids instead.

// Roughly 800K tokens. Haiku 5.5 has a 1M-token context; beyond this we refuse instead of trimming.
export const MAX_CONTEXT_CHARS = 2_800_000;

const PLATFORMS = { googlemeet: 'Google Meet', msteams: 'Microsoft Teams', zoom: 'Zoom', upwork: 'Upwork' };

export function resolveTimeZone(tz) {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

function clock(ts, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(ts));
}

function day(ts, timeZone) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone }).format(new Date(ts));
}

// One caption per line; a stray closing tag in caption text cannot end the transcript block early.
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/<\/(transcript|meeting)/gi, '<\\/$1');

export function buildTranscriptContext(meeting, segments, { timeZone = 'UTC' } = {}) {
  const lineToSegment = new Map();
  const segmentToLine = new Map();
  const lines = [];
  segments.forEach((s, i) => {
    const line = i + 1;
    lineToSegment.set(line, s.id);
    segmentToLine.set(s.id, line);
    lines.push(`[L${line} ${clock(s.ts, timeZone)}] ${clean(s.speaker) || 'Unknown speaker'}: ${clean(s.text)}`);
  });
  const header = [
    meeting.title && meeting.title !== 'Untitled meeting' ? `Title: ${clean(meeting.title)}` : null,
    `Platform: ${PLATFORMS[meeting.platform] || 'Online meeting'}`,
    segments.length ? `Date: ${day(segments[0].ts, timeZone)} (times are ${timeZone})` : null,
    `Lines: ${segments.length}`,
  ].filter(Boolean);
  const text = `<meeting>\n${header.join('\n')}\n</meeting>\n<transcript>\n${lines.join('\n')}\n</transcript>`;
  return { text, lineToSegment, segmentToLine, lineCount: segments.length };
}

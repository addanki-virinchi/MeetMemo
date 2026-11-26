// Rewrites Claude's line citations ([L12], [L3][L9], [L3, L9]) into stable markers while the
// answer streams. "[[cite:N]]" points at citations[N], a segment document id. Citations of
// line ids that do not exist are dropped. A citation split across two stream chunks is held
// back until it is complete, so the client never sees half a marker.

const COMPLETE = /\[(L\d+(?:\s*[,;]\s*L?\d+)*)\]/g;
const PARTIAL_TAIL = /\[(?:L\d*(?:\s*[,;]?\s*L?\d*)*)?$/;
const MAX_HELD = 80;

export function createCitationRewriter(lineToSegment) {
  const citations = [];
  const indexOf = new Map(); // segment id -> index in citations
  let held = '';

  function rewrite(text) {
    const added = [];
    const out = text.replace(COMPLETE, (_, list) => list
      .split(/\s*[,;]\s*/)
      .map((part) => {
        const segmentId = lineToSegment.get(Number(part.replace(/^L/, '')));
        if (!segmentId) return '';
        if (!indexOf.has(segmentId)) {
          indexOf.set(segmentId, citations.length);
          citations.push(segmentId);
          added.push({ index: citations.length - 1, segmentId });
        }
        return `[[cite:${indexOf.get(segmentId)}]]`;
      })
      .join(''));
    return { text: out, added };
  }

  return {
    citations,
    push(chunk) {
      let buf = held + chunk;
      held = '';
      const start = buf.lastIndexOf('[');
      if (start !== -1 && buf.length - start <= MAX_HELD && PARTIAL_TAIL.test(buf.slice(start))) {
        held = buf.slice(start);
        buf = buf.slice(0, start);
      }
      return rewrite(buf);
    },
    flush() {
      const rest = held;
      held = '';
      return rewrite(rest);
    },
  };
}

// Stored answers back into the form Claude wrote them, for follow-up context.
export function citationsToLines(text, citations, segmentToLine) {
  return String(text || '').replace(/\[\[cite:(\d+)\]\]/g, (_, i) => {
    const line = segmentToLine.get(citations?.[Number(i)]);
    return line ? `[L${line}]` : '';
  });
}

// Reads an uploaded meeting document in the browser and returns what the backend should store.
//
//   { kind: 'text', text }     text formats and Office files (docx, pptx, xlsx, odt, odp, ods),
//                              converted here so only plain text leaves the browser
//   { kind: 'data', data }     PDFs and images, sent as base64; the server has Claude turn them
//                              into text once
//
// Throws an Error with a user-facing message for formats that cannot be read.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const SERVER_TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};
const TEXT_EXT = new Set(['txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'log', 'ini',
  'html', 'htm', 'rtf', 'ics', 'vtt', 'srt', 'eml', 'tex', 'rst', 'adoc', 'org']);
const LEGACY = { doc: '.docx or .pdf', ppt: '.pptx or .pdf', xls: '.xlsx or .csv', pages: '.pdf', key: '.pdf', numbers: '.csv' };

const ext = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';

const OFFICE_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  odt: 'application/vnd.oasis.opendocument.text',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
};

export function mimeFor(file) {
  const e = ext(file.name);
  return SERVER_TYPES[e] || OFFICE_TYPES[e] || file.type || (TEXT_EXT.has(e) ? 'text/plain' : 'application/octet-stream');
}

// ---- helpers ----
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
const stripTags = (xml) => decodeEntities(xml.replace(/<[^>]+>/g, ''));
const tidy = (s) => s.replace(/ \| *\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

async function toBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Rejects binary data that is not text (many NULs or replacement characters).
function looksLikeText(s) {
  if (!s) return false;
  const sample = s.slice(0, 20000);
  let bad = 0;
  for (const ch of sample) if (ch === '\u0000' || ch === '�') bad += 1;
  return bad / sample.length < 0.02;
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
  doc.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
  doc.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6,section,article').forEach((n) => n.append('\n'));
  return doc.body?.textContent || '';
}

function rtfToText(rtf) {
  return rtf
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((Number(n) + 65536) % 65536))
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '');
}

// ---- minimal ZIP reader (Office Open XML / OpenDocument are ZIP files) ----
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file looks damaged and could not be opened.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n += 1) {
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compSize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    async text(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
      const raw = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return dec.decode(raw);
      if (e.method === 8) return dec.decode(await inflateRaw(raw));
      throw new Error('This file uses a compression format the browser cannot read.');
    },
  };
}

const byNumber = (re) => (a, b) => Number(a.match(re)[1]) - Number(b.match(re)[1]);

async function docxText(zip) {
  const parts = ['word/document.xml', ...zip.names.filter((n) => /^word\/(footnotes|endnotes)\.xml$/.test(n))];
  const out = [];
  for (const name of parts) {
    const xml = await zip.text(name);
    if (!xml) continue;
    out.push(stripTags(xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>\s*<\/w:tc>/g, '</w:tc>') // a cell's last paragraph does not end the row
      .replace(/<\/w:tc>/g, ' | ')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<\/w:p>/g, '\n')));
  }
  return out.join('\n\n');
}

async function pptxText(zip) {
  const re = /^ppt\/slides\/slide(\d+)\.xml$/;
  const slides = zip.names.filter((n) => re.test(n)).sort(byNumber(re));
  const out = [];
  for (const [i, name] of slides.entries()) {
    const xml = await zip.text(name);
    const body = stripTags(xml.replace(/<a:br\/>/g, '\n').replace(/<\/a:p>/g, '\n')).trim();
    const notesName = `ppt/notesSlides/notesSlide${name.match(re)[1]}.xml`;
    const notesXml = await zip.text(notesName);
    const notes = notesXml ? stripTags(notesXml.replace(/<\/a:p>/g, '\n')).trim() : '';
    out.push(`Slide ${i + 1}:\n${body}${notes ? `\nSpeaker notes:\n${notes}` : ''}`);
  }
  return out.join('\n\n');
}

async function xlsxText(zip) {
  const parse = (xml) => new DOMParser().parseFromString(xml, 'application/xml');
  const shared = [];
  const ssXml = await zip.text('xl/sharedStrings.xml');
  if (ssXml) for (const si of parse(ssXml).getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
  const wbXml = await zip.text('xl/workbook.xml');
  const sheetNames = wbXml ? [...parse(wbXml).getElementsByTagName('sheet')].map((s) => s.getAttribute('name')) : [];
  const re = /^xl\/worksheets\/sheet(\d+)\.xml$/;
  const sheets = zip.names.filter((n) => re.test(n)).sort(byNumber(re));
  const out = [];
  for (const [i, name] of sheets.entries()) {
    const doc = parse(await zip.text(name));
    const rows = [];
    for (const row of doc.getElementsByTagName('row')) {
      const cells = [];
      for (const c of row.getElementsByTagName('c')) {
        const t = c.getAttribute('t');
        const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
        if (t === 's') cells.push(shared[Number(v)] ?? '');
        else if (t === 'inlineStr') cells.push([...c.getElementsByTagName('t')].map((x) => x.textContent).join(''));
        else cells.push(v);
      }
      if (cells.some((x) => String(x).trim())) rows.push(cells.join(' | '));
    }
    if (rows.length) out.push(`Sheet: ${sheetNames[i] || `Sheet ${i + 1}`}\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
}

async function odfText(zip) {
  const xml = await zip.text('content.xml');
  if (!xml) return '';
  return stripTags(xml
    .replace(/<text:tab\/>/g, '\t')
    .replace(/<text:line-break\/>/g, '\n')
    .replace(/<\/text:p>\s*<\/table:table-cell>/g, '</table:table-cell>')
    .replace(/<\/table:table-cell>/g, ' | ')
    .replace(/<\/(text:p|text:h|table:table-row)>/g, '\n'));
}

const ZIP_READERS = { docx: docxText, docm: docxText, pptx: pptxText, pptm: pptxText, xlsx: xlsxText, xlsm: xlsxText, odt: odfText, odp: odfText, ods: odfText };

export async function readDocument(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`"${file.name}" is larger than 10 MB. Upload a smaller file or its text.`);
  if (!file.size) throw new Error(`"${file.name}" is empty.`);
  const e = ext(file.name);
  if (LEGACY[e]) throw new Error(`Older .${e} files can't be read. Save it as ${LEGACY[e]} and upload that.`);
  if (SERVER_TYPES[e] || /^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.type === 'application/pdf') {
    return { kind: 'data', data: await toBase64(file) };
  }
  if (ZIP_READERS[e]) {
    const text = tidy(await ZIP_READERS[e](await readZip(file)));
    if (!text) throw new Error(`No text was found in "${file.name}".`);
    return { kind: 'text', text };
  }
  // Everything else: read it as text, if it is text.
  const raw = await file.text();
  if (!looksLikeText(raw)) throw new Error(`"${file.name}" isn't a format MeetMemo can read. Upload text, Word, PowerPoint, Excel, PDF or image files.`);
  let text = raw;
  if (e === 'html' || e === 'htm' || file.type === 'text/html') text = htmlToText(raw);
  else if (e === 'rtf' || raw.startsWith('{\\rtf')) text = rtfToText(raw);
  text = tidy(text);
  if (!text) throw new Error(`No text was found in "${file.name}".`);
  return { kind: 'text', text };
}

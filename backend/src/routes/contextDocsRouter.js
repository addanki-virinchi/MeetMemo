import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { asyncHandler, httpError } from '../middleware/error.js';
import { logger } from '../logger.js';
import { EXTRACTABLE, buildExtractRequest } from '../ai/assist.js';
import { AI_MESSAGES, mapAiError } from '../ai/errors.js';

// Meeting context documents: anything the user wants Claude to know during their calls (client
// background, requirements, product details, agenda, prepared questions, notes). Uploaded on the
// Meetings page; every *active* document is read by the in-meeting assistant (aiAssistRouter.js).
// Mounted at /v1/context-docs behind requireAuth.
//
// Storage: users/{uid}/contextDocs/{docId}
//   { name, mimeType, size, source: 'text'|'extracted', text, chars, truncated, active, createdAt, updatedAt }
// Only the extracted plain text is kept; the original file is never stored.

export const MAX_DOCS_PER_USER = 20;
export const MAX_DOC_CHARS = 200_000; // about 50K tokens per document
const MAX_DOC_BYTES = 900_000; // Firestore documents are limited to 1 MiB
const MAX_UPLOAD_BASE64 = 14 * 1024 * 1024; // ~10 MB file; the route's JSON limit is 15 MB
const EXTRACT_TIMEOUT_MS = 170_000;

const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mimeType: z.string().max(150).default('application/octet-stream'),
  size: z.number().int().nonnegative().optional(),
  text: z.string().max(2_000_000).optional(),
  data: z.string().max(MAX_UPLOAD_BASE64).regex(/^[A-Za-z0-9+/]+=*$/, 'data must be base64').optional(),
}).strict().refine((b) => (b.text === undefined) !== (b.data === undefined), { message: 'send exactly one of text or data' });

const patchSchema = z.object({
  active: z.boolean().optional(),
  name: z.string().trim().min(1).max(200).optional(),
}).strict();

const toMillis = (v) => (v == null ? null : typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : Number(v) || null);

// Plain text tidied for storage: normalized newlines, no NULs or long blank runs.
export function normalizeText(raw) {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

// Fits text into one Firestore document; says whether anything was cut.
export function fitText(text) {
  let out = text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text;
  while (Buffer.byteLength(out, 'utf8') > MAX_DOC_BYTES) out = out.slice(0, Math.floor(out.length * 0.9));
  return { text: out, truncated: out.length < text.length };
}

export function publicDoc(id, d) {
  return {
    id,
    name: d.name,
    mimeType: d.mimeType,
    size: d.size ?? null,
    source: d.source,
    chars: d.chars ?? (d.text || '').length,
    truncated: !!d.truncated,
    active: d.active !== false,
    preview: String(d.text || '').slice(0, 280),
    createdAt: toMillis(d.createdAt),
    updatedAt: toMillis(d.updatedAt),
  };
}

export function createContextDocsRouter({
  db, FieldValue, anthropic, model = 'claude-haiku-5-5',
  uploadsPerWindow = 20, windowMs = 10 * 60_000, extractTimeoutMs = EXTRACT_TIMEOUT_MS,
}) {
  const router = Router();
  const docsOf = (uid) => db.collection('users').doc(uid).collection('contextDocs');

  async function ownedDoc(req) {
    if (!DOC_ID.test(req.params.docId)) throw httpError(404, 'not_found', 'Document not found');
    const ref = docsOf(req.user.uid).doc(req.params.docId);
    const snap = await ref.get();
    if (!snap.exists) throw httpError(404, 'not_found', 'Document not found');
    return { ref, snap };
  }

  const uploadLimiter = rateLimit({
    windowMs,
    limit: uploadsPerWindow,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `ctx-upload:${req.user.uid}`,
    handler: (req, res) => res.status(429).json({ error: 'rate_limited', message: 'Many uploads in a short time. Try again in a few minutes.' }),
  });

  router.get('/', asyncHandler(async (req, res) => {
    const snap = await docsOf(req.user.uid).get();
    const items = snap.docs.map((d) => publicDoc(d.id, d.data())).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    res.json({ items, limit: MAX_DOCS_PER_USER });
  }));

  // Turns a PDF or image into text with Claude. Returns { text, truncated }.
  async function extract(body) {
    if (!anthropic) throw httpError(503, 'ai_unavailable', AI_MESSAGES.ai_unavailable);
    const startedAt = Date.now();
    try {
      const final = await anthropic.messages
        .stream(buildExtractRequest({ model, mimeType: body.mimeType, data: body.data, name: body.name }), { signal: AbortSignal.timeout(extractTimeoutMs) })
        .finalMessage();
      if (final.stop_reason === 'refusal') throw httpError(422, 'ai_declined', "Claude couldn't read this document.");
      const text = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      logger.info({ model, ms: Date.now() - startedAt, stopReason: final.stop_reason, usage: final.usage && { input: final.usage.input_tokens, output: final.usage.output_tokens } }, 'Context document extracted');
      return { text, truncated: final.stop_reason === 'max_tokens' };
    } catch (err) {
      if (err?.expose === true) throw err; // our own httpError
      if (err instanceof Anthropic.APIUserAbortError || err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw httpError(504, 'ai_timeout', 'Reading this document took too long. Try a shorter file, or paste its text into a .txt file.');
      }
      const { code, log } = mapAiError(err);
      logger[log]({ err: { name: err?.name, status: err?.status, message: err?.message } }, 'Context document extraction failed');
      // A PDF the API cannot open (encrypted, corrupt, too many pages) comes back as a 400.
      if (err?.status === 400) throw httpError(422, 'unreadable_document', "Claude couldn't open this file. If it is password-protected or very long, export the text and upload that instead.");
      throw httpError(code === 'ai_busy' ? 503 : 502, code, AI_MESSAGES[code] || AI_MESSAGES.ai_failed);
    }
  }

  router.post('/', uploadLimiter, asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const col = docsOf(req.user.uid);
    const existing = await col.get();
    if (existing.size >= MAX_DOCS_PER_USER) {
      throw httpError(409, 'too_many_documents', `You can keep up to ${MAX_DOCS_PER_USER} documents. Delete one you no longer need first.`);
    }
    let raw;
    let source;
    let extractCut = false;
    if (body.data !== undefined) {
      if (!EXTRACTABLE[body.mimeType]) {
        throw httpError(415, 'unsupported_type', 'This file type cannot be read. Upload text, Word, PowerPoint, Excel, PDF or image files.');
      }
      const r = await extract(body);
      raw = r.text;
      extractCut = r.truncated;
      source = 'extracted';
    } else {
      raw = body.text;
      source = 'text';
    }
    const normalized = normalizeText(raw);
    if (!normalized) throw httpError(422, 'empty_document', 'No readable text was found in this file.');
    const { text, truncated } = fitText(normalized);
    const ref = col.doc();
    await ref.set({
      name: body.name,
      mimeType: body.mimeType,
      ...(body.size !== undefined ? { size: body.size } : {}),
      source,
      text,
      chars: text.length,
      truncated: truncated || extractCut,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    const snap = await ref.get();
    res.status(201).json(publicDoc(ref.id, snap.data()));
  }));

  router.patch('/:docId', asyncHandler(async (req, res) => {
    const body = patchSchema.parse(req.body);
    const { ref } = await ownedDoc(req);
    await ref.update({ ...body, updatedAt: FieldValue.serverTimestamp() });
    const snap = await ref.get();
    res.json(publicDoc(ref.id, snap.data()));
  }));

  router.delete('/:docId', asyncHandler(async (req, res) => {
    const { ref } = await ownedDoc(req);
    await ref.delete();
    res.status(204).end();
  }));

  return router;
}

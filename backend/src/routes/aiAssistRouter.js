import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { asyncHandler, httpError } from '../middleware/error.js';
import { logger } from '../logger.js';
import { isValidSegmentDocId } from '../lib/segments.js';
import { resolveTimeZone } from '../ai/transcript.js';
import { AI_MESSAGES, mapAiError } from '../ai/errors.js';
import {
  ACTIONS, OUTPUT_SCHEMAS, MAX_TRANSCRIPT_LINES, buildDocsBlock, mergeTranscript, buildAssistRequest,
} from '../ai/assist.js';

// In-meeting assistant actions (the Claude tab in the Meet panel): "Ask this question",
// "What to ask next" and "Steer to close". Mounted at /v1/meetings/:id/ai/assist behind
// requireAuth. Reads the meeting (ownership), the most recent saved lines, and the user's active
// context documents; stores nothing. The client sends its newest caption lines, which may not be
// saved yet, and the suggestions it already showed (so "What to ask next" does not repeat itself).

const SAVED_LINES = 150; // saved tail merged with the client's lines
const TIMEOUT_MS = 45_000;

const lineSchema = z.object({
  id: z.string().refine(isValidSegmentDocId, 'invalid segment id'),
  speaker: z.string().max(200).optional(),
  ts: z.number().int().nonnegative(),
  text: z.string().max(4000),
});

const assistSchema = z.object({
  action: z.enum(ACTIONS),
  lines: z.array(lineSchema).max(MAX_TRANSCRIPT_LINES * 2).default([]),
  previous: z.array(z.object({ action: z.enum(ACTIONS), text: z.string().max(2000) })).max(30).default([]),
  userName: z.string().max(200).optional(),
  answerLanguage: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).optional(),
  timeZone: z.string().max(64).optional(),
}).strict();

export function createAssistRouter({
  db, anthropic, model = 'claude-haiku-5-5',
  perWindow = 40, windowMs = 10 * 60_000, timeoutMs = TIMEOUT_MS,
}) {
  const router = Router({ mergeParams: true });
  const meetings = db.collection('meetings');

  async function ownedMeeting(req) {
    const ref = meetings.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().ownerId !== req.user.uid) throw httpError(404, 'not_found', 'Meeting not found');
    return { ref, snap };
  }

  const limiter = rateLimit({
    windowMs,
    limit: perWindow,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `ai-assist:${req.user.uid}`,
    handler: (req, res) => res.status(429).json({ error: 'ai_rate_limited', message: 'Many requests in a short time. Try again in a few minutes.' }),
  });

  async function activeDocs(uid) {
    const snap = await db.collection('users').doc(uid).collection('contextDocs').get();
    const toMs = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : 0);
    return snap.docs.map((d) => d.data()).filter((d) => d.active !== false)
      .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
  }

  router.post('/', limiter, asyncHandler(async (req, res) => {
    const body = assistSchema.parse(req.body);
    // Ownership first, before any other read or any model call.
    const { ref, snap } = await ownedMeeting(req);
    if (!anthropic) throw httpError(503, 'ai_unavailable', AI_MESSAGES.ai_unavailable);

    const [savedSnap, docs] = await Promise.all([
      ref.collection('segments').orderBy('ts', 'desc').limit(SAVED_LINES).get(),
      activeDocs(req.user.uid),
    ]);
    const lines = mergeTranscript({
      savedLines: savedSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      clientLines: body.lines,
    });
    const docsBlock = buildDocsBlock(docs);
    const params = buildAssistRequest({
      action: body.action,
      model,
      docsBlock,
      lines,
      meeting: snap.data(),
      userName: body.userName,
      previous: body.previous,
      timeZone: resolveTimeZone(body.timeZone),
      answerLanguage: body.answerLanguage,
    });
    params.output_config = { ...params.output_config, format: zodOutputFormat(OUTPUT_SCHEMAS[body.action]) };

    const startedAt = Date.now();
    let message;
    try {
      message = await anthropic.messages.parse(params, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError || err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw httpError(504, 'ai_timeout', AI_MESSAGES.ai_timeout);
      }
      const { code, log } = mapAiError(err);
      logger[log]({ err: { name: err?.name, status: err?.status, message: err?.message }, action: body.action }, 'Assist request failed');
      throw httpError(code === 'ai_busy' ? 503 : 502, code, AI_MESSAGES[code] || AI_MESSAGES.ai_failed);
    }
    const u = message.usage || {};
    logger.info({
      action: body.action, model, ms: Date.now() - startedAt, lines: lines.length, docs: docsBlock.used,
      stopReason: message.stop_reason,
      usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 },
    }, 'Assist answered');

    if (message.stop_reason === 'refusal') throw httpError(422, 'ai_declined', AI_MESSAGES.ai_declined);
    const out = message.parsed_output;
    if (!out || !String(out.text || '').trim()) throw httpError(502, 'empty_answer', AI_MESSAGES.empty_answer);

    res.json({
      action: body.action,
      ...out,
      context: { documents: docsBlock.used, omitted: docsBlock.omitted, cut: docsBlock.cut, lines: lines.length },
    });
  }));

  return router;
}

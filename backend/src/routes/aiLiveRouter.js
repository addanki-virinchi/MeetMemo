import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler, httpError } from '../middleware/error.js';
import { logger } from '../logger.js';
import { isValidSegmentDocId } from '../lib/segments.js';
import { liveSystem, mergeLiveContext, buildLivePrompt, createLiveParser, validateSources, MAX_CONTEXT_LINES } from '../ai/live.js';
import { resolveTimeZone } from '../ai/transcript.js';
import { AI_MESSAGES, mapAiError } from '../ai/errors.js';
import { modelField, effortField, applyModelChoice, slowness } from '../ai/models.js';

// Live auto-answer: one candidate question from a live meeting, decided and answered by Claude
// Haiku from a bounded excerpt of recent lines. Mounted at /v1/meetings/:id/ai/live behind
// requireAuth; every route checks meeting ownership before anything else (and before any model
// call).
//
// Storage (deleted with the meeting, because DELETE /v1/meetings/:id is recursive):
//   meetings/{id}/aiLive/{questionId}   one card per question; questionId is the stable segment
//   document id of the question line (sync/segment-id.js), so caption revisions, duplicate
//   deliveries, retries and worker restarts all land on the same card.
//   { status: pending|answered|skipped|error, question: { text, speaker, ts }, answer,
//     sources: [segmentId], errorCode, stopReason, model, usage, attempts, leaseUntil, ... }
// Transcript text sent as context is never stored here.

const LEASE_MS = 60_000; // a crashed request frees its claim after this long
const FIRST_TOKEN_MS = 12_000; // provider timeout before anything arrives
const TOTAL_MS = 30_000; // whole answer
const MAX_TOKENS = 400; // 2–4 sentences plus SOURCE_IDS; a ceiling, not a target
const GROWTH_WORDS = 3; // a skipped question is re-checked once its caption grew by this much

const line = z.object({
  id: z.string().refine(isValidSegmentDocId, 'invalid segment id'),
  speaker: z.string().max(200).optional(),
  ts: z.number().int().nonnegative(),
  text: z.string().max(2000),
});
const answerSchema = z.object({
  questionId: z.string().refine(isValidSegmentDocId, 'invalid segment id'),
  question: z.object({
    text: z.string().trim().min(1).max(2000),
    speaker: z.string().max(200).optional(),
    ts: z.number().int().nonnegative(),
  }),
  context: z.array(line).max(MAX_CONTEXT_LINES * 2).default([]),
  answerLanguage: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).optional(),
  timeZone: z.string().max(64).optional(),
  retry: z.boolean().optional(),
  model: modelField,
  effort: effortField,
}).strict();

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const toMillis = (v) => (v == null ? null : typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : Number(v) || null);

export function publicCard(id, c) {
  return {
    questionId: id,
    status: c.status,
    question: c.question,
    answer: c.answer || '',
    sources: c.sources || [],
    errorCode: c.errorCode || null,
    stopReason: c.stopReason || null,
    createdAt: toMillis(c.createdAt),
    updatedAt: toMillis(c.updatedAt),
  };
}

export function createLiveRouter({
  db, FieldValue, anthropic, model = 'claude-haiku-5-5',
  perWindow = 60, windowMs = 10 * 60_000, maxConcurrentPerMeeting = 2,
  firstTokenMs = FIRST_TOKEN_MS, totalMs = TOTAL_MS, now = () => Date.now(),
}) {
  const router = Router({ mergeParams: true });
  const meetings = db.collection('meetings');
  const inFlight = new Map(); // meetingId -> active requests on this instance

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
    keyGenerator: (req) => `ai-live:${req.user.uid}`,
    handler: (req, res) => res.status(429).json({ error: 'ai_rate_limited', message: 'Auto-answer is paused for a few minutes: many questions were detected in a short time.' }),
  });

  // Completed (and failed) cards for this meeting, oldest question first. Skipped and in-progress
  // candidates are not cards.
  router.get('/', asyncHandler(async (req, res) => {
    const { ref } = await ownedMeeting(req);
    const snap = await ref.collection('aiLive').orderBy('questionTs').limit(200).get();
    const cards = snap.docs.map((d) => publicCard(d.id, d.data())).filter((c) => c.status === 'answered' || c.status === 'error');
    res.json({ enabled: !!anthropic, model, cards });
  }));

  // Claims the card for this question, or explains why no model call is needed.
  // Returns { claimed: true } or { claimed: false, card } (already decided) or throws 409.
  async function claim(meetingRef, body) {
    const cardRef = meetingRef.collection('aiLive').doc(body.questionId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(cardRef);
      const cur = snap.exists ? snap.data() : null;
      if (cur) {
        const leased = cur.status === 'pending' && (cur.leaseUntil || 0) > now();
        if (leased) throw httpError(409, 'in_progress', 'This question is already being answered.');
        if (cur.status === 'answered') return { claimed: false, card: publicCard(cardRef.id, cur) };
        // A skipped caption that kept growing (the question was unfinished) gets one more look.
        if (cur.status === 'skipped' && words(body.question.text) < words(cur.question?.text) + GROWTH_WORDS) return { claimed: false, card: publicCard(cardRef.id, cur) };
        // Failed answers are retried only on request, never by a re-delivery.
        if (cur.status === 'error' && !body.retry) return { claimed: false, card: publicCard(cardRef.id, cur) };
      }
      tx.set(cardRef, {
        status: 'pending',
        question: { text: body.question.text, ...(body.question.speaker ? { speaker: body.question.speaker } : {}), ts: body.question.ts },
        questionTs: body.question.ts,
        answer: '',
        sources: [],
        errorCode: null,
        model: body.model || model,
        effort: body.effort || 'low',
        attempts: (cur?.attempts || 0) + 1,
        leaseUntil: now() + LEASE_MS,
        ...(cur ? {} : { createdAt: FieldValue.serverTimestamp() }),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { claimed: true, cardRef };
    });
  }

  // The last few saved lines up to the question, to reconcile with what the client sent.
  async function savedTail(meetingRef, questionTs) {
    const snap = await meetingRef.collection('segments').orderBy('ts', 'desc').limit(MAX_CONTEXT_LINES * 2).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.ts <= questionTs + 5_000);
  }

  // Streams the decision as Server-Sent Events:
  //   card    { questionId, question }        the model chose ANSWER: show a card now
  //   delta   { text }                        answer text (never the SOURCE_IDS label)
  //   sources { ids: [segmentId] }            validated against the lines sent in this request
  //   done    { status: answered|skipped, stopReason }   or   error { code, message }
  // When no model call is needed (already answered, skipped, failed) the reply is plain JSON:
  //   { status: 'exists', card }
  router.post('/answer', limiter, asyncHandler(async (req, res) => {
    const body = answerSchema.parse(req.body);
    if (!anthropic) throw httpError(503, 'ai_unavailable', AI_MESSAGES.ai_unavailable);
    const { ref: meetingRef } = await ownedMeeting(req); // ownership before any model call
    const meetingId = meetingRef.id;
    if ((inFlight.get(meetingId) || 0) >= maxConcurrentPerMeeting) throw httpError(429, 'ai_live_busy', AI_MESSAGES.ai_live_busy);

    const claimed = await claim(meetingRef, body);
    if (!claimed.claimed) { res.json({ status: 'exists', card: claimed.card }); return; }
    const { cardRef } = claimed;
    inFlight.set(meetingId, (inFlight.get(meetingId) || 0) + 1);
    const release = () => {
      const n = (inFlight.get(meetingId) || 1) - 1;
      if (n > 0) inFlight.set(meetingId, n); else inFlight.delete(meetingId);
    };

    const startedAt = now();
    let lines;
    try {
      const question = { id: body.questionId, ...body.question };
      lines = mergeLiveContext({ question, clientLines: body.context, savedLines: await savedTail(meetingRef, body.question.ts) });
    } catch (err) {
      release();
      await cardRef.set({ status: 'error', errorCode: 'ai_failed', leaseUntil: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
      throw err;
    }
    const timeZone = resolveTimeZone(body.timeZone);
    const prompt = buildLivePrompt(lines, body.questionId, { timeZone });

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    let open = true;
    let finished = false;
    let clientGone = false;
    let timedOut = false;
    let stream = null;
    const controller = new AbortController();
    const write = (event, data) => { if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const ping = setInterval(() => { if (open) res.write(': ping\n\n'); }, 10_000);
    const abort = () => { controller.abort(); stream?.abort(); };
    res.on('close', () => {
      open = false;
      clearInterval(ping);
      if (!finished) { clientGone = true; abort(); }
    });
    const slow = slowness(body, model); // Sonnet/Opus and higher effort get more time
    let firstTimer = setTimeout(() => { timedOut = true; abort(); }, Math.round(firstTokenMs * slow));
    const totalTimer = setTimeout(() => { timedOut = true; abort(); }, Math.round(totalMs * slow));

    const parser = createLiveParser();
    let decision = null;
    let answer = '';
    let stopReason = null;
    let usage = null;
    let status = 'skipped';
    let errorCode = null;
    let firstTextMs = null;
    let sources = [];
    const onEvents = (events) => {
      for (const ev of events) {
        if (ev.type === 'decision') {
          decision = ev.decision;
          if (decision === 'answer') write('card', { questionId: body.questionId, question: body.question });
          else abort(); // SKIP (or no usable decision): stop generating right away
        } else if (ev.type === 'text') {
          if (firstTextMs === null) firstTextMs = now() - startedAt;
          answer += ev.text;
          write('delta', { text: ev.text });
        }
      }
    };

    try {
      // Short classification-plus-answer: no thinking where the model allows it (Opus always
      // thinks), the user's model and effort (default: server model, low), for time to first text.
      stream = anthropic.messages.stream(applyModelChoice({
        max_tokens: MAX_TOKENS,
        system: [{ type: 'text', text: liveSystem({ answerLanguage: body.answerLanguage }) }],
        messages: [{ role: 'user', content: prompt.text }],
      }, body, { fallback: model, thinkingOff: true }), { signal: controller.signal });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
          onEvents(parser.push(event.delta.text));
          if (decision && decision !== 'answer') break;
        }
      }
      if (decision === null || decision === 'answer') {
        const fin = parser.finish();
        if (decision === null && fin.decision) {
          decision = fin.decision;
          if (decision === 'answer') write('card', { questionId: body.questionId, question: body.question });
        }
        if (decision === 'answer') {
          if (fin.text) { if (firstTextMs === null) firstTextMs = now() - startedAt; answer += fin.text; write('delta', { text: fin.text }); }
          sources = validateSources(fin.sourceLabels, prompt.labelToSegment);
          const final = await stream.finalMessage();
          stopReason = final.stop_reason;
          const u = final.usage || {};
          usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
          if (stopReason === 'refusal') { status = 'error'; errorCode = 'ai_declined'; answer = ''; sources = []; }
          else if (!answer.trim()) { status = 'error'; errorCode = 'empty_answer'; }
          else status = 'answered';
        }
      }
    } catch (err) {
      if (decision && decision !== 'answer' && !clientGone && !timedOut) {
        status = 'skipped'; // our own abort after SKIP
      } else if (clientGone) {
        status = 'error'; errorCode = 'stopped';
      } else if (timedOut) {
        status = 'error'; errorCode = 'ai_timeout';
        logger.warn({ meetingId, questionId: body.questionId, decided: !!decision }, 'Live answer timed out');
      } else {
        const mapped = mapAiError(err);
        status = 'error'; errorCode = mapped.code;
        logger[mapped.log]({ meetingId, questionId: body.questionId, status: err?.status, name: err?.constructor?.name }, 'Live answer request failed');
      }
    } finally {
      clearTimeout(firstTimer);
      clearTimeout(totalTimer);
      release();
    }
    finished = true;
    if (status === 'skipped' && decision === 'invalid') logger.info({ meetingId, questionId: body.questionId }, 'Live answer: no usable decision line, treated as skip');

    // A failure before the model decided leaves no card behind (it was never shown); the next
    // delivery of the same question may try again. After ANSWER, keep the error for Retry.
    const shown = decision === 'answer';
    let deleted = false;
    try {
      const fresh = await meetingRef.get(); // the meeting may have been deleted meanwhile
      if (!fresh.exists || fresh.data().ownerId !== req.user.uid) deleted = true;
      else if (status === 'error' && !shown) await db.recursiveDelete(cardRef);
      else {
        await cardRef.set({
          status, answer, sources, errorCode, stopReason, usage, leaseUntil: null,
          latency: { firstTextMs, totalMs: now() - startedAt }, updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    } catch (err) {
      logger.error({ meetingId, questionId: body.questionId, code: err.code }, 'Could not save live answer');
    }
    // Ids, status and token counts only: never question, transcript or answer text.
    logger.info({ meetingId, questionId: body.questionId, model: body.model || model, effort: body.effort || 'low', status, errorCode, stopReason, usage, lines: lines.length, firstTextMs, ms: now() - startedAt }, 'Live answer');

    if (deleted) write('error', { code: 'not_found', message: 'This meeting was deleted.' });
    else if (status === 'error') write('error', { code: errorCode, message: AI_MESSAGES[errorCode] || AI_MESSAGES.ai_failed, shown });
    else {
      if (status === 'answered') write('sources', { ids: sources });
      write('done', { status, stopReason });
    }
    clearInterval(ping);
    if (open) res.end();
  }));

  return router;
}

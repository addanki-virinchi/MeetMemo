import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler, httpError } from '../middleware/error.js';
import { logger } from '../logger.js';
import { FEATURES } from '../ai/prompts.js';
import { buildTranscriptContext, resolveTimeZone, MAX_CONTEXT_CHARS } from '../ai/transcript.js';
import { createCitationRewriter, citationsToLines } from '../ai/citations.js';
import { AI_MESSAGES, mapAiError } from '../ai/errors.js';
import { createLiveRouter } from './aiLiveRouter.js';

// Ask MeetMemo AI: questions about one meeting, answered by Claude from that meeting's saved
// transcript. Mounted at /v1/meetings/:id/ai behind requireAuth.
//
// Storage (deleted with the meeting by DELETE /v1/meetings/:id, which is recursive):
//   meetings/{id}/aiThreads/{threadId}               { feature, title, model, createdAt, updatedAt }
//   meetings/{id}/aiThreads/{threadId}/messages/{m}  { role, text, citations, status, ... , seq }
//
// Factory with injected dependencies so tests can run against fakes (backend/test/ai.test.js).
const SEGMENT_PAGE = 1000;
const MAX_SEGMENT_PAGES = 200;
const HISTORY_TURNS = 10;
const MAX_TOKENS = 8000; // answers are short by design; this is a ceiling, not a target
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/;

const askSchema = z.object({
  question: z.string().trim().min(1).max(2000).optional(),
  threadId: z.string().regex(THREAD_ID).optional(),
  regenerate: z.boolean().optional(),
  answerLanguage: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).optional(),
  timeZone: z.string().max(64).optional(),
}).strict().refine((b) => (b.regenerate ? !!b.threadId : !!b.question), {
  message: 'question is required (or threadId with regenerate: true)',
});

const toMillis = (v) => (v == null ? null : typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : Number(v) || null);

export function createAiRouter({
  db, FieldValue, FieldPath, anthropic, model = 'claude-haiku-5-5',
  questionsPerWindow = 20, windowMs = 10 * 60_000, now = () => Date.now(),
  liveModel = model, livePerWindow = 60, liveOptions = {},
}) {
  const router = Router({ mergeParams: true });
  // Live auto-answer (aiLiveRouter.js): /v1/meetings/:id/ai/live
  router.use('/live', createLiveRouter({ db, FieldValue, anthropic, model: liveModel, perWindow: livePerWindow, windowMs, now, ...liveOptions }));
  const meetings = db.collection('meetings');
  const feature = FEATURES.qa;

  // Same ownership rule as meetingsRouter: 404 (not 403) so other users' ids cannot be probed.
  async function ownedMeeting(req) {
    const ref = meetings.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().ownerId !== req.user.uid) throw httpError(404, 'not_found', 'Meeting not found');
    return { ref, snap };
  }

  async function threadOf(meetingRef, threadId) {
    if (!THREAD_ID.test(threadId)) throw httpError(404, 'thread_not_found', 'Conversation not found');
    const ref = meetingRef.collection('aiThreads').doc(threadId);
    const snap = await ref.get();
    if (!snap.exists) throw httpError(404, 'thread_not_found', 'Conversation not found');
    return { ref, data: snap.data() };
  }

  async function messagesOf(threadRef) {
    const snap = await threadRef.collection('messages').orderBy('seq').get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  // The whole transcript, in the same (ts, id) order the reader shows.
  async function loadSegments(meetingRef) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < MAX_SEGMENT_PAGES; page += 1) {
      let q = meetingRef.collection('segments').orderBy('ts').orderBy(FieldPath.documentId()).limit(SEGMENT_PAGE);
      if (cursor) q = q.startAfter(cursor.ts, cursor.id);
      const snap = await q.get();
      for (const d of snap.docs) items.push({ id: d.id, ...d.data() });
      if (snap.size < SEGMENT_PAGE) return items;
      const last = snap.docs[snap.size - 1];
      cursor = { ts: last.data().ts, id: last.id };
    }
    throw httpError(413, 'transcript_too_long', 'This transcript is too long for Ask AI.');
  }

  // Earlier completed exchanges, oldest first, as Claude saw them (line ids, not markers).
  function priorTurns(history, ctx) {
    const turns = [];
    for (let i = 0; i < history.length; i += 1) {
      const q = history[i];
      const a = history[i + 1];
      if (q.role !== 'user' || a?.role !== 'assistant') continue;
      if (!['complete', 'cut_short'].includes(a.status) || !a.text) continue;
      turns.push([q.text, citationsToLines(a.text, a.citations, ctx.segmentToLine)]);
    }
    return turns.slice(-HISTORY_TURNS);
  }

  // Order is fixed for prompt caching: system, then the transcript block (cached), then turns.
  function buildRequest(ctx, turns, question, answerLanguage) {
    const all = [...turns, [question, null]];
    const messages = [];
    all.forEach(([q, a], i) => {
      messages.push({
        role: 'user',
        content: i === 0
          ? [{ type: 'text', text: ctx.text, cache_control: { type: 'ephemeral' } }, { type: 'text', text: q }]
          : q,
      });
      if (a !== null) messages.push({ role: 'assistant', content: a });
    });
    return {
      model,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: feature.system({ answerLanguage }) }],
      messages,
      output_config: { effort: 'low' }, // grounded Q&A over provided text; Haiku 5.5 defaults to medium
    };
  }

  const askLimiter = rateLimit({
    windowMs,
    limit: questionsPerWindow,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `ai:${req.user.uid}`,
    handler: (req, res) => res.status(429).json({
      error: 'ai_rate_limited',
      message: "You've asked a lot of questions in a short time. Try again in a few minutes.",
    }),
  });

  // Availability plus this meeting's conversations, newest first.
  router.get('/threads', asyncHandler(async (req, res) => {
    const { ref } = await ownedMeeting(req);
    const snap = await ref.collection('aiThreads').orderBy('updatedAt', 'desc').limit(20).get();
    res.json({
      enabled: !!anthropic,
      items: snap.docs.map((d) => {
        const t = d.data();
        return { id: d.id, title: t.title, feature: t.feature, createdAt: toMillis(t.createdAt), updatedAt: toMillis(t.updatedAt) };
      }),
    });
  }));

  router.get('/threads/:threadId', asyncHandler(async (req, res) => {
    const { ref } = await ownedMeeting(req);
    const thread = await threadOf(ref, req.params.threadId);
    const messages = await messagesOf(thread.ref);
    res.json({
      id: thread.ref.id,
      title: thread.data.title,
      messages: messages.map((m) => ({
        id: m.id, role: m.role, text: m.text || '', citations: m.citations || [], status: m.status || 'complete',
        errorCode: m.errorCode || null, lineCountAtAsk: m.lineCountAtAsk ?? null, createdAt: toMillis(m.createdAt),
      })),
    });
  }));

  router.delete('/threads/:threadId', asyncHandler(async (req, res) => {
    const { ref } = await ownedMeeting(req);
    const thread = await threadOf(ref, req.params.threadId);
    await db.recursiveDelete(thread.ref);
    res.status(204).end();
  }));

  // Streams one answer as Server-Sent Events:
  //   meta  { threadId, questionId, answerId, lineCount, timeZone }
  //   cite  { index, segmentId }      (before the delta that first uses it)
  //   delta { text }                  (citations appear as [[cite:N]])
  //   done  { answerId, status, stopReason }   or   error { code, message, answerId }
  // Errors before the stream starts are ordinary JSON responses.
  router.post('/ask', askLimiter, asyncHandler(async (req, res) => {
    const body = askSchema.parse(req.body);
    if (!anthropic) throw httpError(503, 'ai_unavailable', AI_MESSAGES.ai_unavailable);
    const { ref: meetingRef, snap: meetingSnap } = await ownedMeeting(req);

    let threadRef = null;
    let history = [];
    if (body.threadId) {
      const thread = await threadOf(meetingRef, body.threadId);
      threadRef = thread.ref;
      history = await messagesOf(threadRef);
    }

    let question = body.question;
    let questionRef = null;
    let staleAnswers = [];
    if (body.regenerate) {
      let i = history.length - 1;
      while (i >= 0 && history[i].role !== 'user') i -= 1;
      if (i < 0) throw httpError(400, 'invalid_request', 'There is no question to try again');
      question = history[i].text;
      questionRef = threadRef.collection('messages').doc(history[i].id);
      staleAnswers = history.slice(i + 1);
      history = history.slice(0, i);
    }

    const segments = await loadSegments(meetingRef);
    if (!segments.length) throw httpError(409, 'no_transcript', 'This meeting has no saved lines yet, so there is nothing to ask about.');
    const timeZone = resolveTimeZone(body.timeZone);
    const ctx = buildTranscriptContext(meetingSnap.data(), segments, { timeZone });
    if (ctx.text.length > MAX_CONTEXT_CHARS) throw httpError(413, 'transcript_too_long', 'This transcript is too long for Ask AI.');

    // Save the question first, so it is kept even if answering fails.
    const startedAt = now();
    const batch = db.batch();
    if (!threadRef) {
      threadRef = meetingRef.collection('aiThreads').doc();
      batch.set(threadRef, {
        feature: 'qa', title: question.slice(0, 80), model,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      batch.update(threadRef, { updatedAt: FieldValue.serverTimestamp() });
    }
    if (!questionRef) {
      questionRef = threadRef.collection('messages').doc();
      batch.set(questionRef, { role: 'user', text: question, seq: startedAt, createdAt: FieldValue.serverTimestamp() });
    }
    for (const m of staleAnswers) batch.delete(threadRef.collection('messages').doc(m.id));
    await batch.commit();
    const answerRef = threadRef.collection('messages').doc();

    // ---- stream ----
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
    let stream = null;
    const write = (event, data) => { if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const ping = setInterval(() => { if (open) res.write(': ping\n\n'); }, 15_000); // keeps proxies from closing a quiet stream
    res.on('close', () => {
      open = false;
      clearInterval(ping);
      if (!finished) { clientGone = true; stream?.abort(); }
    });

    write('meta', { threadId: threadRef.id, questionId: questionRef.id, answerId: answerRef.id, lineCount: ctx.lineCount, timeZone });

    const rewriter = createCitationRewriter(ctx.lineToSegment);
    let text = '';
    const emit = ({ text: chunk, added }) => {
      for (const c of added) write('cite', c);
      if (chunk) { text += chunk; write('delta', { text: chunk }); }
    };

    let status = 'complete';
    let errorCode = null;
    let stopReason = null;
    let usage = null;
    try {
      stream = anthropic.messages.stream(buildRequest(ctx, priorTurns(history, ctx), question, body.answerLanguage));
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') emit(rewriter.push(event.delta.text));
      }
      emit(rewriter.flush());
      const final = await stream.finalMessage();
      stopReason = final.stop_reason;
      const u = final.usage || {};
      usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
      if (stopReason === 'refusal') { status = 'error'; errorCode = 'ai_declined'; text = ''; rewriter.citations.length = 0; }
      else if (!text.trim()) { status = 'error'; errorCode = 'empty_answer'; }
      else if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') status = 'cut_short';
    } catch (err) {
      if (clientGone) {
        status = 'stopped';
      } else {
        const mapped = mapAiError(err);
        status = 'error';
        errorCode = mapped.code;
        logger[mapped.log]({ meetingId: meetingRef.id, threadId: threadRef.id, status: err?.status, name: err?.constructor?.name }, 'Ask AI request failed');
      }
    }
    finished = true;

    try {
      await answerRef.set({
        role: 'assistant', text, citations: [...rewriter.citations], status, errorCode, stopReason, model, usage,
        lineCountAtAsk: ctx.lineCount, seq: Math.max(now(), startedAt + 1), createdAt: FieldValue.serverTimestamp(),
      });
      await threadRef.update({ updatedAt: FieldValue.serverTimestamp() });
    } catch (err) {
      logger.error({ meetingId: meetingRef.id, threadId: threadRef.id, code: err.code }, 'Could not save Ask AI answer');
    }
    // Ids, status and token counts only: never question, transcript or answer text.
    logger.info({ meetingId: meetingRef.id, threadId: threadRef.id, status, stopReason, usage, lines: ctx.lineCount, ms: now() - startedAt }, 'Ask AI answer');

    if (status === 'error') write('error', { code: errorCode, message: AI_MESSAGES[errorCode] || AI_MESSAGES.ai_failed, answerId: answerRef.id });
    else write('done', { answerId: answerRef.id, status, stopReason });
    clearInterval(ping);
    if (open) res.end();
  }));

  return router;
}

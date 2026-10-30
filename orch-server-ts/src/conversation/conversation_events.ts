import type { FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { createSseStream } from "../sse/sse_stream.js";
import type { SessionHistoryLiveEventSource } from "../session/session_history_routes.js";
import { ConversationHistory } from "./conversation_history.js";
import type { Binding } from "./conversation_types.js";
import type { Item, SourceEvent } from "./conversation_projection.js";
import { isSilent } from "../../../packages/wire-schema/src/conversation_visibility.js";

type Options = { liveEvents?: SessionHistoryLiveEventSource; closeAfterHistorySync?: boolean };
type Wire = { kind: string; [key: string]: unknown };
function frame(event: Wire, id?: number): string {
  return `event: ${event.kind}\n${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function eventId(envelope: Record<string, unknown>, payload: Record<string, unknown>): number | undefined {
  for (const value of [envelope.eventId, envelope.id, payload._event_id]) {
    const n = Number(value);
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return undefined;
}
function at(payload: Record<string, unknown>): string {
  const value = payload.timestamp;
  const date = typeof value === "number" ? new Date(value < 10_000_000_000 ? value * 1000 : value)
    : typeof value === "string" ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}
export async function sendConversationEvents(request: FastifyRequest, reply: FastifyReply, history: ConversationHistory, binding: Binding, options: Options) {
  const header = request.headers["last-event-id"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw !== undefined && !/^\d+$/.test(raw)) return reply.code(400).send({ error: { code:"invalid_request", message:"Invalid event cursor" } });
  const after = raw === undefined ? undefined : Number(raw);
  if (after !== undefined && !Number.isSafeInteger(after)) return reply.code(400).send({ error: { code:"invalid_request", message:"Invalid event cursor" } });
  const pending: Record<string, unknown>[] = [];
  let emit: ((envelope: Record<string, unknown>) => void) | undefined;
  const unsubscribe = options.liveEvents?.subscribe(binding.session_id, e => emit ? emit(e) : pending.push(e));
  try {
    const loaded = await history.load(binding);
    if (after !== undefined && after > loaded.cursor) {
      unsubscribe?.();
      return reply.code(400).send({ error:{ code:"invalid_request", message:"Event cursor is ahead of history" } });
    }
    const liveSnapshot = options.liveEvents?.snapshotLiveText?.(binding.session_id);
    const stream = liveSnapshot?.streams.filter(s => s.text !== null && !s.resetRequired).at(-1);
    if (stream?.text && loaded.projection.activity().busy && loaded.projection.allowsLive()) loaded.projection.setStream(stream.streamIdentity, stream.text);
    const streamState = loaded.projection.stream();
    const replay: Item[] = after === undefined
      ? loaded.items.slice(-200).map(x => x.item)
      : loaded.items.filter(x => x.position > after).map(x => x.item);
    const snapshot = { cursor:String(loaded.cursor), ...loaded.projection.activity(),
      stream_id:streamState.text && !isSilent(streamState.text, true) ? streamState.stream_id : null,
      text:streamState.text, items:replay };
    let lastId = loaded.cursor;
    let liveSequence = liveSnapshot?.throughLiveSeq ?? 0;
    const frames: string[] = [frame({ kind:"snapshot", snapshot }, loaded.cursor)];
    let push: (chunk: string) => void = (chunk) => { frames.push(chunk); };
    const process = async (envelope: Record<string, unknown>) => {
      let payload = record(envelope.event ?? envelope.payload ?? envelope);
      const type = typeof payload.type === "string" ? payload.type : "";
      const id = eventId(envelope, payload);
      const sequence = typeof payload.liveSeq === "number" ? payload.liveSeq : undefined;
      if (id === undefined && sequence !== undefined && (type === "text_start" || type === "text_delta" || type === "text_end")) {
        if (sequence <= liveSequence) return;
        liveSequence = sequence;
      }
      if (id !== undefined && id <= lastId) return;
      if (id !== undefined) {
        lastId = id;
        payload = await history.enrichPayload(payload);
        const source: SourceEvent = { id, type, payload, at: at(payload) };
        const result = loaded.projection.apply(source);
        if (result.item) push(frame({ kind:"item", item:result.item }, id));
        if (result.activity) push(frame({ kind:"activity", ...result.activity }, result.item ? undefined : id));
      } else if (type === "error" || type === "assistant_error") {
        const result = loaded.projection.apply({ id:0, type, payload, at:at(payload) });
        if (result.item) push(frame({ kind:"item", item:{ ...result.item, id:`transient:${randomUUID()}` } }));
        if (result.activity) push(frame({ kind:"activity", ...result.activity }));
      } else {
        const text = loaded.projection.live(type, payload);
        if (text) push(frame({ kind:"text", ...text }));
      }
    };
    while (pending.length) {
      for (const e of pending.splice(0)) await process(e);
    }
    reply.header("content-type", "text/event-stream; charset=utf-8").header("cache-control", "no-cache").header("connection", "keep-alive");
    if (options.closeAfterHistorySync || !unsubscribe) {
      unsubscribe?.();
      return reply.send(frames.join(""));
    }
    const streamOut = createSseStream();
    for (const chunk of frames) streamOut.push(chunk);
    push = streamOut.push;
    let queue = Promise.resolve();
    emit = (envelope) => {
      queue = queue.then(() => process(envelope)).catch(error => {
        streamOut.stream.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    };
    for (const e of pending.splice(0)) emit(e);
    const keepalive = setInterval(() => push(": keepalive\n\n"), 30_000);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true; clearInterval(keepalive); unsubscribe();
    };
    request.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);
    streamOut.stream.on("close", cleanup);
    return reply.send(streamOut.stream);
  } catch (error) {
    unsubscribe?.();
    request.log.warn({ err: error }, "conversation stream initialization failed");
    return reply.code(503).send({ error: { code: "unavailable", message: "Conversation service unavailable" } });
  }
}

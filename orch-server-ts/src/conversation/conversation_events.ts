import type { FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { createSseStream } from "../sse/sse_stream.js";
import type { SessionHistoryLiveEventSource } from "../session/session_history_routes.js";
import { ConversationHistory } from "./conversation_history.js";
import { formatPosition, parsePosition, comparePosition } from "./conversation_position.js";
import type { Binding } from "./conversation_types.js";
import type { Item, SourceEvent } from "./conversation_projection.js";
import { isHumanInput, isKeepalive, isSilent } from "../../../packages/wire-schema/src/conversation_visibility.js";

type Options = { liveEvents?: SessionHistoryLiveEventSource; closeAfterHistorySync?: boolean; watchSwitch?: (id: string, close: () => void) => () => void };
type Wire = { kind: string; [key: string]: unknown };
function frame(event: Wire, id?: string): string {
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
  const after = raw === undefined ? undefined : parsePosition(raw);
  if (raw !== undefined && !after) return reply.code(400).send({ error: { code:"invalid_request", message:"Invalid event cursor" } });
  const pending: Record<string, unknown>[] = [];
  let emit: ((envelope: Record<string, unknown>) => void) | undefined;
  const activeId = binding.active_session_id ?? binding.session_id;
  let switched = false;
  let closeStream: (() => void) | undefined;
  const unwatch = options.watchSwitch?.(binding.session_id, () => { switched = true; closeStream?.(); });
  const unsubscribe = options.liveEvents?.subscribe(activeId, e => emit ? emit(e) : pending.push(e));
  try {
    const loaded = await history.load(binding);
    if (switched || loaded.active.session_id !== activeId) {
      unsubscribe?.(); unwatch?.();
      reply.header("content-type", "text/event-stream; charset=utf-8").header("cache-control", "no-cache");
      return reply.send("");
    }
    if (after !== undefined && comparePosition(after, parsePosition(loaded.cursor)!) > 0) {
      unsubscribe?.(); unwatch?.();
      return reply.code(400).send({ error:{ code:"invalid_request", message:"Event cursor is ahead of history" } });
    }
    const liveSnapshot = options.liveEvents?.snapshotLiveText?.(activeId);
    const stream = liveSnapshot?.streams.filter(s => s.text !== null && !s.resetRequired).at(-1);
    if (stream?.text && loaded.projection.activity().busy && loaded.projection.allowsLive()) loaded.projection.setStream(stream.streamIdentity, stream.text);
    const streamState = loaded.projection.stream();
    const replay: Item[] = after === undefined
      ? loaded.items.slice(-200).map(x => x.item)
      : loaded.items.filter(x => comparePosition(parsePosition(x.position)!, after) > 0).map(x => x.item);
    const snapshot = { cursor:loaded.cursor, ...loaded.projection.activity(),
      stream_id:streamState.text && !isSilent(streamState.text, true) ? streamState.stream_id : null,
      text:streamState.text, items:replay };
    let lastId = parsePosition(loaded.cursor)!.id;
    const ordinal = loaded.active.ordinal;
    let liveSequence = liveSnapshot?.throughLiveSeq ?? 0;
    let transientErrorInTurn = false;
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
        if (isHumanInput(type, payload) && !isKeepalive(payload)) transientErrorInTurn = false;
        const source: SourceEvent = { id, type, payload, at: at(payload) };
        const result = loaded.projection.apply(source);
        const duplicate = (type === "error" || type === "assistant_error") && transientErrorInTurn;
        if (type === "complete") transientErrorInTurn = false;
        if (result.item && !duplicate) push(frame({ kind:"item", item:{...result.item, id:formatPosition(ordinal,id)} }, formatPosition(ordinal,id)));
        if (result.activity) push(frame({ kind:"activity", ...result.activity }, result.item && !duplicate ? undefined : formatPosition(ordinal,id)));
      } else if (type === "error" || type === "assistant_error") {
        const duplicate = loaded.projection.hasErrorInTurn();
        const result = loaded.projection.apply({ id:0, type, payload, at:at(payload) });
        transientErrorInTurn = true;
        if (result.item && !duplicate) push(frame({ kind:"item", item:{ ...result.item, id:`transient:${randomUUID()}` } }));
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
      unsubscribe?.(); unwatch?.();
      return reply.send(frames.join(""));
    }
    const streamOut = createSseStream();
    closeStream = () => streamOut.stream.push(null);
    for (const chunk of frames) streamOut.push(chunk);
    if (switched) closeStream();
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
      cleaned = true; clearInterval(keepalive); unsubscribe(); unwatch?.();
    };
    request.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);
    streamOut.stream.on("close", cleanup);
    return reply.send(streamOut.stream);
  } catch (error) {
    unsubscribe?.(); unwatch?.();
    request.log.warn({ err: error }, "conversation stream initialization failed");
    return reply.code(503).send({ error: { code: "unavailable", message: "Conversation service unavailable" } });
  }
}

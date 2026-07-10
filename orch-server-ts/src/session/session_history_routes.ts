import { Readable } from "node:stream";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  SessionHistoryReadService,
  filterFinalizedAppServerReplayEvents,
  type SessionHistoryProvider,
  type SessionHistoryRawEvent,
} from "./session_history_service.js";
import {
  SessionResourceAccessError,
  type SessionResourceAccessProvider,
} from "./session_resource_access.js";

export type SessionHistoryRouteOptions = {
  provider: SessionHistoryProvider;
  accessProvider?: SessionResourceAccessProvider;
  liveEvents?: SessionHistoryLiveEventSource;
  keepaliveMs?: number;
  closeAfterHistorySync?: boolean;
  foregroundObservers?: SessionHistoryForegroundObservers;
};

export type SessionHistoryLiveEventSource = {
  subscribe: (
    sessionId: string,
    listener: (envelope: Record<string, unknown>) => void,
  ) => (() => void) | undefined;
};

export type SessionHistoryForegroundObservers = {
  observe: (sessionId: string) => () => void;
};

export const sessionHistoryRouteAuthRequirements = {
  "GET /api/sessions/:session_id/events/viewport": true,
  "GET /api/sessions/:session_id/messages": true,
  "GET /api/sessions/:session_id/timeline": true,
  "GET /api/sessions/:session_id/timeline/:timeline_id/trace": true,
  "GET /api/sessions/:session_id/events": true,
} as const;

type SessionParams = {
  session_id: string;
};

type TimelineTraceParams = SessionParams & {
  timeline_id: string;
};

type QueryParseResult<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; field: string; message: string };

type SessionHistorySseFrame = {
  event: string;
  data: string;
  id?: string | number;
};

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const DEFAULT_KEEPALIVE_MS = 30_000;

export function registerSessionHistoryRoutes(
  app: FastifyInstance,
  options: SessionHistoryRouteOptions,
): void {
  const service = new SessionHistoryReadService({ provider: options.provider });

  app.get("/api/sessions/:session_id/events/viewport", async (request, reply) => {
    const yMin = requiredPositiveIntegerQuery(request.query, "y_min");
    if (!yMin.ok) return sendInvalidQuery(reply, yMin);
    const yMax = requiredPositiveIntegerQuery(request.query, "y_max");
    if (!yMax.ok) return sendInvalidQuery(reply, yMax);

    if (!(await ensureSessionAccess(options, request, reply))) return;
    return service.readViewport(sessionParams(request).session_id, yMin.value, yMax.value);
  });

  app.get("/api/sessions/:session_id/messages", async (request, reply) => {
    const limit = limitQuery(request.query);
    if (!limit.ok) return sendInvalidQuery(reply, limit);

    if (!(await ensureSessionAccess(options, request, reply))) return;
    return service.readMessagesPage(
      sessionParams(request).session_id,
      optionalStringQuery(request.query, "before"),
      limit.value,
    );
  });

  app.get("/api/sessions/:session_id/timeline", async (request, reply) => {
    const limit = limitQuery(request.query);
    if (!limit.ok) return sendInvalidQuery(reply, limit);

    if (!(await ensureSessionAccess(options, request, reply))) return;
    return service.readTimelinePage(
      sessionParams(request).session_id,
      optionalStringQuery(request.query, "before"),
      limit.value,
    );
  });

  app.get("/api/sessions/:session_id/timeline/:timeline_id/trace", async (request, reply) => {
    const { session_id: sessionId, timeline_id: timelineId } =
      timelineTraceParams(request);
    if (!(await ensureSessionAccess(options, request, reply))) return;
    const trace = await service.readTimelineTrace(sessionId, timelineId);
    if (trace === null || trace === undefined) {
      return reply.code(404).send({
        error: {
          code: "TRACE_NOT_FOUND",
          message: `trace를 찾을 수 없습니다: ${timelineId}`,
          details: {},
        },
      });
    }
    return trace;
  });

  app.get("/api/sessions/:session_id/events", async (request, reply) =>
    sendSessionEventsStream(request, reply, service, options),
  );
}

export function formatSessionHistorySseFrame(frame: SessionHistorySseFrame): string {
  const lines = [`event: ${frame.event}`];
  if (frame.id !== undefined) {
    lines.push(`id: ${frame.id}`);
  }
  lines.push(`data: ${frame.data}`);
  return `${lines.join("\n")}\n\n`;
}

function sessionParams(request: FastifyRequest): SessionParams {
  return request.params as SessionParams;
}

function timelineTraceParams(request: FastifyRequest): TimelineTraceParams {
  return request.params as TimelineTraceParams;
}

function requiredPositiveIntegerQuery(query: unknown, key: string): QueryParseResult<number> {
  const value = queryValue(query, key);
  if (value === undefined || value === "") {
    return { ok: false, field: key, message: `${key} is required` };
  }
  return positiveIntegerQueryValue(value, key);
}

function limitQuery(query: unknown): QueryParseResult<number> {
  const value = queryValue(query, "limit");
  if (value === undefined || value === "") {
    return { ok: true, value: DEFAULT_LIMIT };
  }
  const parsed = positiveIntegerQueryValue(value, "limit");
  if (!parsed.ok) return parsed;
  if (parsed.value < MIN_LIMIT || parsed.value > MAX_LIMIT) {
    return {
      ok: false,
      field: "limit",
      message: `limit must be between ${MIN_LIMIT} and ${MAX_LIMIT}`,
    };
  }
  return parsed;
}

function positiveIntegerQueryValue(value: unknown, field: string): QueryParseResult<number> {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return { ok: false, field, message: `${field} must be a positive integer` };
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return { ok: false, field, message: `${field} must be a positive integer` };
  }
  return { ok: true, value: parsed };
}

function optionalStringQuery(query: unknown, key: string): string | null {
  const value = queryValue(query, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function queryValue(query: unknown, key: string): unknown {
  if (typeof query !== "object" || query === null || !(key in query)) {
    return undefined;
  }
  const value = (query as Record<string, unknown>)[key];
  return Array.isArray(value) ? value[0] : value;
}

function sendInvalidQuery(
  reply: FastifyReply,
  error: Extract<QueryParseResult<number>, { ok: false }>,
): FastifyReply {
  return reply.code(400).send({
    error: {
      code: "INVALID_QUERY",
      message: error.message,
      details: { field: error.field },
    },
  });
}

async function sendSessionEventsStream(
  request: FastifyRequest,
  reply: FastifyReply,
  service: SessionHistoryReadService,
  options: SessionHistoryRouteOptions,
): Promise<FastifyReply> {
  const sessionId = sessionParams(request).session_id;
  if (!(await ensureSessionAccess(options, request, reply))) return reply;
  const releaseObserver = options.foregroundObservers?.observe(sessionId);
  let pendingLiveEvents: Record<string, unknown>[] = [];
  let liveStream: Readable | null = null;
  let history: SessionHistoryInitialState | undefined;
  let initialFlushed = false;
  const unsubscribe = options.liveEvents?.subscribe(sessionId, (envelope) => {
    if (!initialFlushed) {
      pendingLiveEvents.push(envelope);
      return;
    }
    try {
      const frame = liveSessionEventFrame(envelope, history);
      if (frame !== null) liveStream?.push(formatSessionHistorySseFrame(frame));
    } catch (error) {
      liveStream?.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  try {
    history = await buildSessionHistoryInitialState(request, service, sessionId);
    const frames = [...history.frames];
    if (history.afterId === 0) {
      for (const envelope of pendingLiveEvents) {
        const frame = liveSessionEventFrame(envelope, history);
        if (frame !== null) frames.push(frame);
      }
      pendingLiveEvents = [];
    }
    frames.push(historySyncFrame(history.lastStoredId, unsubscribe !== undefined));
    setSseHeaders(reply);

    if ((options.closeAfterHistorySync ?? true) || unsubscribe === undefined) {
      unsubscribe?.();
      releaseObserver?.();
      return reply.send(frames.map(formatSessionHistorySseFrame).join(""));
    }

    const stream = new Readable({
      read() {},
    });
    liveStream = stream;
    for (const frame of frames) {
      stream.push(formatSessionHistorySseFrame(frame));
    }
    initialFlushed = true;
    for (const envelope of pendingLiveEvents) {
      const frame = liveSessionEventFrame(envelope, history);
      if (frame !== null) stream.push(formatSessionHistorySseFrame(frame));
    }
    pendingLiveEvents = [];
    const keepalive = setInterval(() => {
      stream.push(": keepalive\n\n");
    }, options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(keepalive);
      unsubscribe();
      releaseObserver?.();
    };
    request.raw.on("close", cleanup);
    stream.on("close", cleanup);

    return reply.send(stream);
  } catch (error) {
    unsubscribe?.();
    releaseObserver?.();
    throw error;
  }
}

type SessionHistoryInitialState = {
  readonly frames: SessionHistorySseFrame[];
  readonly afterId: number;
  readonly lastStoredId: number;
  readonly seenEventIds: Set<number>;
};

async function buildSessionHistoryInitialState(
  request: FastifyRequest,
  service: SessionHistoryReadService,
  sessionId: string,
): Promise<SessionHistoryInitialState> {
  const frames: SessionHistorySseFrame[] = [
    {
      event: "init",
      data: JSON.stringify({ agentSessionId: sessionId }),
    },
  ];
  const afterId = resolveSessionHistoryAfterId(request);
  const seenEventIds = new Set<number>();

  if (afterId === 0) {
    const lastEventId = await service.readLastEventId(sessionId);
    return { frames, afterId, lastStoredId: lastEventId, seenEventIds };
  }

  let lastStoredId = 0;
  const replayEvents: SessionHistoryRawEvent[] = [];
  for await (const event of service.streamEventsRaw(sessionId, afterId)) {
    if (event.eventId <= afterId) continue;
    lastStoredId = Math.max(lastStoredId, event.eventId);
    seenEventIds.add(event.eventId);
    replayEvents.push(event);
  }

  for (const event of filterFinalizedAppServerReplayEvents(replayEvents)) {
    frames.push({
      event: event.eventType,
      id: event.eventId,
      data: event.payloadText,
    });
  }
  return { frames, afterId, lastStoredId, seenEventIds };
}

function liveSessionEventFrame(
  envelope: Record<string, unknown>,
  history: SessionHistoryInitialState | undefined,
): SessionHistorySseFrame | null {
  if (history === undefined) return null;
  const payload = isRecord(envelope.event)
    ? envelope.event
    : isRecord(envelope.payload)
      ? envelope.payload
      : envelope;
  const eventId = liveEventId(envelope, payload);
  if (eventId !== undefined) {
    if (history.afterId > 0 && eventId <= history.afterId) return null;
    if (history.seenEventIds.has(eventId)) return null;
    history.seenEventIds.add(eventId);
  }
  return {
    event: typeof payload.type === "string" ? payload.type : "message",
    data: JSON.stringify(payload),
    ...(eventId === undefined ? {} : { id: eventId }),
  };
}

function liveEventId(
  envelope: Record<string, unknown>,
  payload: Record<string, unknown>,
): number | undefined {
  for (const value of [
    envelope.eventId,
    envelope.id,
    payload._event_id,
    payload.id,
  ]) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

async function ensureSessionAccess(
  options: SessionHistoryRouteOptions,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  try {
    await options.accessProvider?.requireSessionAccess({
      request,
      sessionId: sessionParams(request).session_id,
    });
    return true;
  } catch (error) {
    sendSessionAccessError(reply, error);
    return false;
  }
}

function sendSessionAccessError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SessionResourceAccessError) {
    return reply.code(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }
  throw error;
}

function resolveSessionHistoryAfterId(request: FastifyRequest): number {
  const raw =
    headerValue(request.headers["last-event-id"]) ??
    optionalStringQuery(request.query, "lastEventId") ??
    "0";
  if (!/^\d+$/.test(raw)) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function historySyncFrame(
  lastEventId: number,
  isLive = false,
): SessionHistorySseFrame {
  return {
    event: "history_sync",
    data: JSON.stringify({
      type: "history_sync",
      last_event_id: lastEventId,
      is_live: isLive,
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setSseHeaders(reply: FastifyReply): void {
  reply
    .header("content-type", "text/event-stream; charset=utf-8")
    .header("cache-control", "no-cache")
    .header("connection", "keep-alive");
}

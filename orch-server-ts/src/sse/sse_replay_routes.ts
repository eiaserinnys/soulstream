import { Readable } from "node:stream";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  InMemorySseReplayBroadcaster,
  resolveSseResumeCursor,
  type SessionStreamEvent,
  type SseReplayEvent,
  type SseResumeCursor,
  type TaskStreamEvent,
} from "./replay_broadcaster.js";

export type SessionStreamSnapshot = {
  sessions: unknown[];
  total?: number;
};

export type TaskStreamSnapshot = {
  tasks: unknown[];
  total?: number;
};

export type SseReplayRouteOptions = {
  session: {
    broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>;
    loadSnapshot: () => Promise<SessionStreamSnapshot>;
  };
  task: {
    broadcaster: InMemorySseReplayBroadcaster<TaskStreamEvent>;
    loadSnapshot: () => Promise<TaskStreamSnapshot>;
  };
  keepaliveMs?: number;
  replayOnlyForTests?: boolean;
};

export const sseReplayRouteAuthRequirements = {
  "GET /api/sessions/stream": true,
  "GET /api/tasks/stream": true,
} as const;

type SseFrame = {
  event: string;
  id?: string | number;
  data: Record<string, unknown>;
};

type ReplayStreamOptions<TPayload extends object> = {
  broadcaster: InMemorySseReplayBroadcaster<TPayload>;
  loadSnapshot: () => Promise<SseFrame>;
  keepaliveMs?: number;
  replayOnlyForTests?: boolean;
};

const DEFAULT_KEEPALIVE_MS = 30_000;

export function registerSseReplayRoutes(
  app: FastifyInstance,
  options: SseReplayRouteOptions,
): void {
  app.get("/api/sessions/stream", async (request, reply) =>
    sendSseReplayStream(request, reply, {
      broadcaster: options.session.broadcaster,
      loadSnapshot: async () => {
        const snapshot = await options.session.loadSnapshot();
        return {
          event: "session_list",
          data: {
            type: "session_list",
            sessions: snapshot.sessions,
            total: snapshot.total ?? snapshot.sessions.length,
          },
        };
      },
      keepaliveMs: options.keepaliveMs,
      replayOnlyForTests: options.replayOnlyForTests,
    }),
  );

  app.get("/api/tasks/stream", async (request, reply) =>
    sendSseReplayStream(request, reply, {
      broadcaster: options.task.broadcaster,
      loadSnapshot: async () => {
        const snapshot = await options.task.loadSnapshot();
        return {
          event: "task_list",
          data: {
            type: "task_list",
            tasks: snapshot.tasks,
            total: snapshot.total ?? snapshot.tasks.length,
          },
        };
      },
      keepaliveMs: options.keepaliveMs,
      replayOnlyForTests: options.replayOnlyForTests,
    }),
  );
}

export function formatSseFrame(frame: SseFrame): string {
  const lines = [`event: ${frame.event}`];
  if (frame.id !== undefined) {
    lines.push(`id: ${frame.id}`);
  }
  lines.push(`data: ${JSON.stringify(frame.data)}`);
  return `${lines.join("\n")}\n\n`;
}

async function sendSseReplayStream<TPayload extends object>(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReplayStreamOptions<TPayload>,
): Promise<FastifyReply> {
  const cursor = parseCursorFromRequest(request, reply);
  if (cursor === undefined) {
    return reply;
  }

  const replaySeenIds = new Set<number>();
  let pendingLiveEvents: Array<SseReplayEvent<TPayload>> = [];
  let initialFlushed = false;
  let liveStream: Readable | null = null;
  const unsubscribe = options.replayOnlyForTests
    ? undefined
    : options.broadcaster.subscribe((event) => {
        if (!initialFlushed) {
          pendingLiveEvents.push(event);
          return;
        }
        if (!replaySeenIds.has(event.id)) {
          liveStream?.push(formatReplayEvent(event));
        }
      });

  try {
    const initialFrames = await buildInitialFrames(options, cursor, replaySeenIds);
    setSseHeaders(reply);

    if (options.replayOnlyForTests) {
      return reply.send(initialFrames.map(formatSseFrame).join(""));
    }

    const stream = new Readable({
      read() {},
    });
    liveStream = stream;
    for (const frame of initialFrames) {
      stream.push(formatSseFrame(frame));
    }
    initialFlushed = true;
    for (const event of pendingLiveEvents) {
      if (!replaySeenIds.has(event.id)) {
        stream.push(formatReplayEvent(event));
      }
    }
    pendingLiveEvents = [];

    const keepalive = setInterval(() => {
      stream.push(": keepalive\n\n");
    }, options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS);
    const cleanup = () => {
      clearInterval(keepalive);
      unsubscribe?.();
    };
    request.raw.on("close", cleanup);
    stream.on("close", cleanup);

    return reply.send(stream);
  } catch (error) {
    unsubscribe?.();
    throw error;
  }
}

async function buildInitialFrames<TPayload extends object>(
  options: ReplayStreamOptions<TPayload>,
  cursor: SseResumeCursor,
  replaySeenIds: Set<number>,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [
    {
      event: "stream_meta",
      data: options.broadcaster.streamMeta,
    },
  ];

  if (cursor.lastEventId === null) {
    frames.push(await options.loadSnapshot());
    return frames;
  }

  const replay = options.broadcaster.replayFromCursor(cursor);
  if (replay.gap) {
    frames.push({
      event: "replay_gap",
      data: {
        type: "replay_gap",
        latest_id: replay.latestId,
        instance_id: replay.instanceId,
        reason: replay.gapReason,
      },
    });
    return frames;
  }

  for (const event of replay.events) {
    replaySeenIds.add(event.id);
    frames.push(replayEventFrame(event));
  }
  return frames;
}

function replayEventFrame<TPayload extends object>(
  event: SseReplayEvent<TPayload>,
): SseFrame {
  return {
    event: eventNameForPayload(event.payload),
    id: event.id,
    data: event.payload as Record<string, unknown>,
  };
}

function formatReplayEvent<TPayload extends object>(
  event: SseReplayEvent<TPayload>,
): string {
  return formatSseFrame(replayEventFrame(event));
}

function eventNameForPayload(payload: object): string {
  if ("type" in payload && typeof payload.type === "string") {
    return payload.type;
  }
  return "message";
}

function parseCursorFromRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): SseResumeCursor | undefined {
  try {
    return resolveSseResumeCursor({
      lastEventIdHeader: headerValue(request.headers["last-event-id"]),
      lastEventIdQuery: queryValue(request.query, "lastEventId"),
      instanceIdQuery: queryValue(request.query, "instanceId"),
    });
  } catch (error) {
    reply.code(400).send({
      error: {
        code: "INVALID_SSE_CURSOR",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return undefined;
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function queryValue(query: unknown, key: string): string | null {
  if (typeof query !== "object" || query === null || !(key in query)) {
    return null;
  }
  const value = (query as Record<string, unknown>)[key];
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : null;
  }
  return typeof value === "string" ? value : null;
}

function setSseHeaders(reply: FastifyReply): void {
  reply
    .header("content-type", "text/event-stream; charset=utf-8")
    .header("cache-control", "no-cache")
    .header("connection", "keep-alive");
}

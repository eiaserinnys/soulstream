import type { FastifyInstance, FastifyReply } from "fastify";

import {
  parseExecuteProxyPayload,
  type ExecuteProxyNewProviderRequest,
  type ExecuteProxyResumeProviderRequest,
} from "./execute_proxy_payloads.js";

export type ExecuteProxyRawEvent = {
  event?: unknown;
  payload?: unknown;
  eventId?: string | number;
  id?: string | number;
  [key: string]: unknown;
};

export type ExecuteProxySseResult = {
  agentSessionId: string;
  nodeId: string;
  events?: readonly ExecuteProxyRawEvent[];
};

export type ExecuteProxyTextResult = {
  body: string;
  contentType?: string;
  statusCode?: number;
};

export type ExecuteProxyResult = ExecuteProxySseResult | ExecuteProxyTextResult;

export type ExecuteProxyProvider = {
  executeNew: (
    payload: ExecuteProxyNewProviderRequest,
  ) => Promise<ExecuteProxyResult> | ExecuteProxyResult;
  executeResume: (
    payload: ExecuteProxyResumeProviderRequest,
  ) => Promise<ExecuteProxyResult> | ExecuteProxyResult;
};

export type ExecuteProxyRouteOptions = {
  provider: ExecuteProxyProvider;
};

export class ExecuteProxyRouteError extends Error {
  readonly statusCode: number;
  readonly detail: unknown;

  constructor(statusCode: number, detail: unknown) {
    super(typeof detail === "string" ? detail : "Execute proxy route error");
    this.name = "ExecuteProxyRouteError";
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

export const executeProxyRouteAuthRequirements = {
  "POST /api/execute": true,
} as const;

type SseFrame = {
  event: string;
  id?: string | number;
  data: unknown;
};

export function registerExecuteProxyRoutes(
  app: FastifyInstance,
  options: ExecuteProxyRouteOptions,
): void {
  app.post("/api/execute", async (request, reply) => {
    const payload = parseExecuteProxyPayload(request.body, request);
    if (!payload.ok) {
      return reply.code(payload.statusCode).send({ detail: payload.detail });
    }

    try {
      const result = await (
        payload.value.mode === "new"
          ? options.provider.executeNew(payload.value.value)
          : options.provider.executeResume(payload.value.value)
      );
      return sendExecuteProxyResult(reply, result);
    } catch (error) {
      if (error instanceof ExecuteProxyRouteError) {
        return reply.code(error.statusCode).send({ detail: error.detail });
      }
      throw error;
    }
  });
}

export function formatExecuteProxySseFrame(frame: SseFrame): string {
  const lines = [`event: ${frame.event}`];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  lines.push(`data: ${JSON.stringify(frame.data)}`);
  return `${lines.join("\n")}\n\n`;
}

function sendExecuteProxyResult(
  reply: FastifyReply,
  result: ExecuteProxyResult,
): FastifyReply {
  if (isTextResult(result)) {
    return reply
      .code(result.statusCode ?? 200)
      .type(result.contentType ?? "text/event-stream")
      .send(result.body);
  }
  return reply.type("text/event-stream").send(formatExecuteProxyEventList(result));
}

function formatExecuteProxyEventList(result: ExecuteProxySseResult): string {
  const frames: SseFrame[] = [
    {
      event: "init",
      data: {
        type: "init",
        agent_session_id: result.agentSessionId,
        node_id: result.nodeId,
      },
    },
  ];

  for (const event of result.events ?? []) {
    const frame = rawEventToFrame(event);
    frames.push(frame);
    if (frame.event === "complete" || frame.event === "error") break;
  }
  return frames.map(formatExecuteProxySseFrame).join("");
}

function rawEventToFrame(raw: ExecuteProxyRawEvent): SseFrame {
  const eventPayload =
    isJsonObject(raw.event) ? raw.event
      : isJsonObject(raw.payload) ? raw.payload
        : undefined;
  if (eventPayload !== undefined) {
    return {
      event: typeof eventPayload.type === "string" ? eventPayload.type : "message",
      id: raw.eventId ?? raw.id ?? (eventPayload._event_id as string | number | undefined),
      data: eventPayload,
    };
  }
  return {
    event: "message",
    id: raw.eventId ?? raw.id,
    data: raw,
  };
}

function isTextResult(result: ExecuteProxyResult): result is ExecuteProxyTextResult {
  return "body" in result;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type {
  ClaudePermissionMode,
  ExecuteProxyCallerInfo,
  ExecuteProxyContextItem,
  ExecuteProxyNewProviderRequest,
  ExecuteProxyResumeProviderRequest,
  ReasoningEffort,
} from "./execute_proxy_payloads.js";

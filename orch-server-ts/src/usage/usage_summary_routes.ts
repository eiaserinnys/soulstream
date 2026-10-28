import type { FastifyInstance } from "fastify";

import { createSseStream } from "../sse/sse_stream.js";
import type { UsageSummaryService } from "./usage_summary_service.js";

export type UsageSummaryRouteOptions = {
  readonly service: Pick<UsageSummaryService, "getSummary"> &
    Partial<Pick<UsageSummaryService, "subscribe">>;
  readonly replayOnlyForTests?: boolean;
};

export const usageSummaryRouteAuthRequirements = {
  "GET /api/usage/summary": true,
  "GET /api/usage/stream": true,
} as const;

export function registerUsageSummaryRoutes(
  app: FastifyInstance,
  options: UsageSummaryRouteOptions,
): void {
  app.get("/api/usage/summary", async () => options.service.getSummary());

  app.get("/api/usage/stream", async (request, reply) => {
    reply
      .header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache")
      .header("connection", "keep-alive");
    if (options.replayOnlyForTests) {
      return reply.send(formatUsageSummaryFrame(options.service.getSummary()));
    }

    const { stream, push } = createSseStream();
    let closed = false;
    const unsubscribe = options.service.subscribe?.((snapshot) => {
      push(formatUsageSummaryFrame(snapshot));
    });
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      unsubscribe?.();
    };
    const keepalive = setInterval(() => push(": keepalive\n\n"), 30_000);
    push(formatUsageSummaryFrame(options.service.getSummary()));
    request.raw.on("close", cleanup);
    stream.on("close", cleanup);
    return reply.send(stream);
  });
}

function formatUsageSummaryFrame(snapshot: ReturnType<UsageSummaryService["getSummary"]>): string {
  return `event: usage_summary\ndata: ${JSON.stringify({ type: "usage_summary", ...snapshot })}\n\n`;
}

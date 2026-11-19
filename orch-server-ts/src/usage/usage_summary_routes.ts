import type { FastifyInstance } from "fastify";

import { createSseStream } from "../sse/sse_stream.js";
import type { SessionStatisticsUpdateNotifier } from "./session_statistics_update_notifier.js";
import type { UsageSummaryService } from "./usage_summary_service.js";

export type UsageSummaryRouteOptions = {
  readonly service: Pick<UsageSummaryService, "getSummary" | "collectOnce"> &
    Partial<Pick<UsageSummaryService, "subscribe">>;
  /** Session statistics changed; the stream emits a refetch hint to listeners. */
  readonly statisticsUpdates?: Pick<SessionStatisticsUpdateNotifier, "subscribe">;
  readonly replayOnlyForTests?: boolean;
};

export const usageSummaryRouteAuthRequirements = {
  "GET /api/usage/summary": true,
  "GET /api/usage/stream": true,
  "POST /api/usage/refresh": true,
} as const;

export function registerUsageSummaryRoutes(
  app: FastifyInstance,
  options: UsageSummaryRouteOptions,
): void {
  app.get("/api/usage/summary", async () => options.service.getSummary());

  app.post("/api/usage/refresh", async () => {
    await options.service.collectOnce();
    return options.service.getSummary();
  });

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
    const unsubscribeStatistics = options.statisticsUpdates?.subscribe(() => {
      push(formatSessionStatisticsUpdatedFrame());
    });
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      unsubscribe?.();
      unsubscribeStatistics?.();
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

function formatSessionStatisticsUpdatedFrame(): string {
  return `event: session_statistics_updated\ndata: ${JSON.stringify({ type: "session_statistics_updated" })}\n\n`;
}

import { describe, expect, it, vi } from "vitest";

import {
  SESSION_TIMELINE_EVENT_TYPES,
  createApp,
  parseOrchServerConfig,
  type SessionHistoryProvider,
} from "../src/index.js";
import { parseTimelineDebugKindsQuery } from "../src/session/session_history_query.js";
import { isRequestedTimelineEventType } from "../src/session/session_history_service.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

function createHarness() {
  const readTimeline = vi.fn(async () => [[], null] as [unknown[], string | null]);
  const provider = { readTimeline } as unknown as SessionHistoryProvider;
  const app = createApp({
    config,
    sessionHistoryRoutes: { provider, closeAfterHistorySync: true },
  });
  return { app, readTimeline };
}

describe("session timeline event_types filter", () => {
  it("uses the shared timeline event inventory and excludes the schema-outside system event", () => {
    expect(SESSION_TIMELINE_EVENT_TYPES).toContain("system_message");
    expect(SESSION_TIMELINE_EVENT_TYPES).toContain("generation_started");
    expect(SESSION_TIMELINE_EVENT_TYPES).not.toContain("system");
    expect(isRequestedTimelineEventType("complete")).toBe(true);
    expect(isRequestedTimelineEventType("future_event")).toBe(false);
  });

  it("passes an additive event_types subset to timeline reads", async () => {
    const { app, readTimeline } = createHarness();

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/timeline?event_types=user_message,assistant_message",
    });

    expect(response.statusCode).toBe(200);
    expect(readTimeline).toHaveBeenCalledWith(
      "sess-1",
      null,
      50,
      ["user_message", "assistant_message"],
    );
    await app.close();
  });

  it("passes an explicitly requested debug_kinds array to timeline reads", async () => {
    const { app, readTimeline } = createHarness();

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/timeline?event_types=debug&debug_kinds=persistent_decision&debug_kinds=persistent_jev_candidates&debug_kinds=persistent_instruction_recorded&limit=1",
    });

    expect(response.statusCode).toBe(200);
    expect(readTimeline).toHaveBeenCalledWith(
      "sess-1",
      null,
      1,
      ["debug"],
      ["persistent_decision", "persistent_jev_candidates", "persistent_instruction_recorded"],
    );
    await app.close();
  });

  it("keeps the default timeline filter and allows complete only when explicitly requested", async () => {
    const defaultEvents = [{ type: "assistant_message", id: 1 }];
    const readTimeline = vi.fn(async (_sessionId: string, _before: string | null, _limit: number, eventTypes?: readonly string[]) => {
      return [eventTypes === undefined ? defaultEvents : [
        { type: "complete", id: 2 },
        ...(eventTypes.includes("context_usage") ? [{ type: "context_usage", id: 3 }] : []),
      ], null] as [unknown[], string | null];
    });
    const app = createApp({
      config,
      sessionHistoryRoutes: { provider: { readTimeline } as unknown as SessionHistoryProvider, closeAfterHistorySync: true },
    });

    const defaultResponse = await app.inject({ method: "GET", url: "/api/sessions/sess-1/timeline" });
    expect(defaultResponse.statusCode).toBe(200);
    expect(defaultResponse.json().messages).toEqual(defaultEvents);
    expect(readTimeline).toHaveBeenCalledWith("sess-1", null, 50);

    const explicitResponse = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/timeline?event_types=complete,context_usage",
    });
    expect(explicitResponse.statusCode).toBe(200);
    expect(explicitResponse.json().messages).toEqual([
      { type: "complete", id: 2 },
      { type: "context_usage", id: 3 },
    ]);
    expect(readTimeline).toHaveBeenLastCalledWith("sess-1", null, 50, ["complete", "context_usage"]);
    await app.close();
  });

  it("rejects empty and unknown event_types before provider access", async () => {
    const { app, readTimeline } = createHarness();

    for (const query of ["event_types=", "event_types=user_message,future_event"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/sessions/sess-1/timeline?${query}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "INVALID_QUERY", details: { field: "event_types" } },
      });
    }
    expect(readTimeline).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects empty and unknown debug_kinds before provider access", async () => {
    const { app, readTimeline } = createHarness();

    for (const query of ["debug_kinds=", "debug_kinds=future_kind"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/sessions/sess-1/timeline?${query}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "INVALID_QUERY", details: { field: "debug_kinds" } },
      });
    }
    expect(readTimeline).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an empty debug_kinds array", () => {
    expect(parseTimelineDebugKindsQuery([])).toMatchObject({
      ok: false,
      field: "debug_kinds",
    });
  });
});

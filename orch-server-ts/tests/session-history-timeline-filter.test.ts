import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  parseOrchServerConfig,
  type SessionHistoryProvider,
} from "../src/index.js";
import { SESSION_TIMELINE_EVENT_TYPES } from "@soulstream/wire-schema";
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

    const toolResponse = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/timeline?event_types=tool_result",
    });
    expect(toolResponse.statusCode).toBe(200);
    expect(readTimeline).toHaveBeenLastCalledWith("sess-1", null, 50, ["tool_result"]);
    await app.close();
  });

  it("accepts the legacy soul-app event_types list that still names retired events, and drops them from the read", async () => {
    const { app, readTimeline } = createHarness();
    const legacyAppEventTypes = "user_message,intervention_sent,session_notification,assistant_message,turn_summary,debug,thinking,tool_start,tool_result,error,assistant_error,system_message,context_usage,compact,input_request,input_request_expired,input_request_responded,tool_approval_requested,tool_approval_resolved,agent_updated,handoff_requested,handoff_occurred,guardrail_tripwire,away_summary,credential_alert,realtime_status,realtime_transcript,generation_started,report_timeline,report_timeline_question_closed,complete";

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/sess-1/timeline?event_types=${legacyAppEventTypes}`,
    });

    expect(response.statusCode).toBe(200);
    const requested = (readTimeline.mock.calls as unknown as unknown[][])[0]?.[3] as string[];
    expect(requested).toContain("assistant_message");
    for (const retired of ["agent_updated", "handoff_requested", "handoff_occurred", "guardrail_tripwire"]) {
      expect(requested).not.toContain(retired);
    }
    await app.close();
  });

  it("still rejects unknown names next to retired ones", async () => {
    const { app, readTimeline } = createHarness();
    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/timeline?event_types=agent_updated,future_event",
    });
    expect(response.statusCode).toBe(400);
    expect(readTimeline).not.toHaveBeenCalled();
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

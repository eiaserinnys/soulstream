import { describe, expect, it } from "vitest";
import {
  buildHistoryPageUrl,
  HISTORY_PAGE_SIZE,
  toSSEEvent,
  type HistoricalMessage,
} from "./useMessageHistoryBuffer";
import { buildToolTraceUrl as buildToolTraceUrlFromHooks } from "./hooks";

describe("buildHistoryPageUrl", () => {
  it("uses the semantic timeline endpoint for the first history page", () => {
    const url = new URL(buildHistoryPageUrl("sess/1", null), "https://example.test");
    expect(url.pathname).toBe("/api/sessions/sess%2F1/timeline");
    expect(url.searchParams.get("limit")).toBe(String(HISTORY_PAGE_SIZE));
    expect(url.searchParams.get("event_types")?.split(",")).toEqual([
      "user_message",
      "intervention_sent",
      "session_notification",
      "assistant_message",
      "turn_summary",
      "tool_start",
      "tool_result",
      "error",
      "assistant_error",
      "system_message",
      "compact",
      "input_request",
      "input_request_expired",
      "input_request_responded",
      "tool_approval_requested",
      "tool_approval_resolved",
      "agent_updated",
      "handoff_requested",
      "handoff_occurred",
      "guardrail_tripwire",
      "away_summary",
    ]);
  });

  it("passes the before cursor to the timeline endpoint", () => {
    const url = new URL(buildHistoryPageUrl("sess-1", "cursor-1"), "https://example.test");
    expect(url.searchParams.get("before")).toBe("cursor-1");
    expect(url.searchParams.get("event_types")).not.toContain("thinking");
    expect(url.searchParams.get("event_types")).not.toContain("context_usage");
  });
});

describe("buildToolTraceUrl", () => {
  it("encodes stable tool timeline ids for lazy trace fetch", () => {
    expect(buildToolTraceUrlFromHooks("sess/1", "tool:toolu_1")).toBe(
      "/api/sessions/sess%2F1/timeline/tool%3Atoolu_1/trace",
    );
  });
});

describe("toSSEEvent", () => {
  it("keeps the existing renderer-compatible event shape", () => {
    const message: HistoricalMessage = {
      id: 7,
      parent_event_id: null,
      event_type: "tool_start",
      payload: {
        tool_use_id: 42,
        request_id: 99,
        command: "pnpm test",
      },
      created_at: "2026-05-23T00:00:00+00:00",
    };

    expect(toSSEEvent(message)).toEqual({
      eventId: 7,
      event: {
        type: "tool_start",
        tool_use_id: "42",
        request_id: "99",
        command: "pnpm test",
      },
    });
  });

  it("uses the timeline row event_type over legacy SDK payload.type", () => {
    const message: HistoricalMessage = {
      id: 8,
      parent_event_id: null,
      event_type: "tool_start",
      payload: {
        type: "tool_use",
        tool_use_id: "toolu_pending",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
        timeline_id: "tool:toolu_pending",
      },
      created_at: "2026-05-24T00:00:00+00:00",
    };

    expect(toSSEEvent(message)).toEqual({
      eventId: 8,
      event: {
        type: "tool_start",
        tool_use_id: "toolu_pending",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
        timeline_id: "tool:toolu_pending",
      },
    });
  });
});

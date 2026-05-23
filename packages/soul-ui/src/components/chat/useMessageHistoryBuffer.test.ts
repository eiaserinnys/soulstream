import { describe, expect, it } from "vitest";
import {
  buildHistoryPageUrl,
  HISTORY_PAGE_SIZE,
  toSSEEvent,
  type HistoricalMessage,
} from "./useMessageHistoryBuffer";

describe("buildHistoryPageUrl", () => {
  it("uses the semantic timeline endpoint for the first history page", () => {
    expect(buildHistoryPageUrl("sess/1", null)).toBe(
      `/api/sessions/sess%2F1/timeline?limit=${HISTORY_PAGE_SIZE}`,
    );
  });

  it("passes the before cursor to the timeline endpoint", () => {
    expect(buildHistoryPageUrl("sess-1", "cursor-1")).toBe(
      `/api/sessions/sess-1/timeline?limit=${HISTORY_PAGE_SIZE}&before=cursor-1`,
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
});

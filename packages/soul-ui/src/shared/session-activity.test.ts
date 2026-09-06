import { describe, expect, it } from "vitest";

import type { SessionSummary } from "./session-types";
import {
  compareSessionActivityDesc,
  getSessionActivityMs,
  getSessionActivityTimestamp,
  normalizeLastMessage,
} from "./session-activity";

describe("normalizeLastMessage", () => {
  it("accepts only non-empty user/assistant messages with a valid timestamp", () => {
    expect(normalizeLastMessage({
      type: "user_message",
      preview: "  hello  ",
      timestamp: "2026-09-06T12:00:00Z",
    })).toEqual({
      type: "user_message",
      preview: "hello",
      timestamp: "2026-09-06T12:00:00Z",
    });
    expect(normalizeLastMessage({
      type: "assistant_message",
      preview: "answer",
      timestamp: "2026-09-06T12:01:00Z",
    })?.type).toBe("assistant_message");
  });

  it("keeps optional event ids and truncates previews by Unicode code point", () => {
    const preview = `${"🙂".repeat(199)}끝잘림`;
    const normalized = normalizeLastMessage({
      type: "assistant_message",
      preview,
      timestamp: "2026-09-06T12:00:00Z",
      event_id: 42,
    });

    expect(Array.from(normalized?.preview ?? "")).toHaveLength(200);
    expect(normalized?.preview.endsWith("끝")).toBe(true);
    expect(normalized?.eventId).toBe(42);
  });

  it("rejects unreadable, blank, and malformed messages", () => {
    expect(normalizeLastMessage({
      type: "tool_result",
      preview: "noise",
      timestamp: "2026-09-06T12:00:00Z",
    })).toBeUndefined();
    expect(normalizeLastMessage({
      type: "user_message",
      preview: "   \n ",
      timestamp: "2026-09-06T12:00:00Z",
    })).toBeUndefined();
    expect(normalizeLastMessage({
      type: "assistant_message",
      preview: "answer",
      timestamp: "not-a-date",
    })).toBeUndefined();
  });
});

describe("session activity timestamp", () => {
  const session = (overrides: Partial<SessionSummary>): SessionSummary => ({
    agentSessionId: "session-a",
    status: "running",
    eventCount: 0,
    ...overrides,
  });

  it("orders activity by message, then creation, then legacy update time", () => {
    const value = session({
      lastMessage: {
        type: "assistant_message",
        preview: "latest message",
        timestamp: "2026-09-06T12:00:00Z",
      },
      createdAt: "2026-09-05T12:00:00Z",
      updatedAt: "2026-09-07T12:00:00Z",
    });

    expect(getSessionActivityTimestamp(value)).toBe("2026-09-06T12:00:00Z");
    expect(getSessionActivityMs(value)).toBe(Date.parse("2026-09-06T12:00:00Z"));
  });

  it("validates each fallback candidate independently", () => {
    expect(getSessionActivityTimestamp(session({
      createdAt: "bad-created-at",
      updatedAt: "2026-09-04T12:00:00Z",
    }))).toBe("2026-09-04T12:00:00Z");
    expect(getSessionActivityTimestamp(session({
      createdAt: "2026-09-03T12:00:00Z",
      updatedAt: "2026-09-04T12:00:00Z",
    }))).toBe("2026-09-03T12:00:00Z");
  });

  it("uses session identity to keep equal-timestamp pagination ties stable", () => {
    const second = session({
      agentSessionId: "session-b",
      lastMessage: {
        type: "assistant_message",
        preview: "first",
        timestamp: "2026-09-06T12:00:00Z",
      },
    });
    const first = session({
      agentSessionId: "session-a",
      lastMessage: {
        type: "assistant_message",
        preview: "second",
        timestamp: "2026-09-06T12:00:00Z",
      },
    });

    expect([second, first].sort(compareSessionActivityDesc).map((item) => item.agentSessionId))
      .toEqual(["session-a", "session-b"]);
  });
});

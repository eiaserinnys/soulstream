import { describe, expect, it } from "vitest";

import {
  normalizeLastChatMessage,
  projectSessionFeedSummary,
  projectSessionFeedUpdate,
  sessionFeedActivityMs,
} from "../src/index.js";

describe("session feed projection", () => {
  it("normalizes aliases into one compact snake-case semantic patch", () => {
    expect(projectSessionFeedUpdate({
      type: "session_updated",
      agentSessionId: "session-a",
      status: "running",
      updatedAt: "2026-09-06T12:00:00.000Z",
      lastEventId: 9,
      lastReadEventId: 7,
      reviewRequired: true,
      reviewState: "needs_review",
      terminationReason: null,
      metadata: { huge: "raw cache field" },
      prompt: "must not be repeated on updates",
      nodeId: "node-a",
    })).toEqual({
      type: "session_updated",
      agent_session_id: "session-a",
      status: "running",
      updated_at: "2026-09-06T12:00:00.000Z",
      last_event_id: 9,
      last_read_event_id: 7,
      review_required: true,
      review_state: "needs_review",
      termination_reason: null,
    });
  });

  it("keeps only canonical final chat message fields and trims previews", () => {
    expect(normalizeLastChatMessage({
      type: "assistant_message",
      event_id: 42,
      preview: "  answer  ",
      timestamp: "2026-09-06T12:00:00+00:00",
      raw: "omitted",
    })).toEqual({
      type: "assistant_message",
      eventId: 42,
      preview: "answer",
      timestamp: "2026-09-06T12:00:00.000Z",
    });
    expect(normalizeLastChatMessage({
      type: "turn_summary",
      preview: "summary",
      timestamp: "2026-09-06T12:00:00.000Z",
    })).toBeNull();
  });

  it("truncates snapshot prompts by Unicode codepoint and removes raw fields", () => {
    const projected = projectSessionFeedSummary({
      agentSessionId: "session-a",
      prompt: "가".repeat(205),
      metadata: { large: true },
      lastMessage: null,
    });

    expect(Array.from(String(projected.prompt))).toHaveLength(200);
    expect(projected).not.toHaveProperty("metadata");
    expect(projected).toMatchObject({
      pendingAttentions: [],
      attentionRevision: 0,
      recentNotices: [],
      notificationWatermark: 0,
      noticesTruncated: false,
    });
  });

  it("orders activity by last message, then creation, then legacy update", () => {
    expect(sessionFeedActivityMs({
      lastMessage: {
        type: "user_message",
        preview: "latest",
        timestamp: "2026-09-06T12:00:03.000Z",
      },
      createdAt: "2026-09-06T12:00:02.000Z",
      updatedAt: "2026-09-06T12:00:04.000Z",
    })).toBe(Date.parse("2026-09-06T12:00:03.000Z"));
    expect(sessionFeedActivityMs({
      createdAt: "2026-09-06T12:00:02.000Z",
      updatedAt: "2026-09-06T12:00:04.000Z",
    })).toBe(Date.parse("2026-09-06T12:00:02.000Z"));
    expect(sessionFeedActivityMs({
      updatedAt: "2026-09-06T12:00:04.000Z",
    })).toBe(Date.parse("2026-09-06T12:00:04.000Z"));
  });
});

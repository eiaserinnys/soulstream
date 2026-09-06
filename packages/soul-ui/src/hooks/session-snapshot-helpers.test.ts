import { describe, expect, it } from "vitest";

import type { SessionSummary } from "../shared/types";
import { applySessionLifecycleSnapshotToList } from "./session-snapshot-helpers";

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    agentSessionId: "session-a",
    status: "running",
    reviewState: "not_required",
    eventCount: 0,
    createdAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

describe("applySessionLifecycleSnapshotToList", () => {
  it("projects lifecycle and latest valid message without replacing list-only fields", () => {
    const current = session({
      prompt: "preserve me",
      status: "running",
      updatedAt: "2026-09-01T00:00:00Z",
    });
    const incoming = session({
      status: "completed",
      reviewState: "needs_review",
      updatedAt: "2026-09-02T00:00:00Z",
      lastMessage: {
        type: "assistant_message",
        preview: "done",
        timestamp: "2026-09-02T00:00:00Z",
      },
    });

    const result = applySessionLifecycleSnapshotToList(
      [current],
      new Map([[incoming.agentSessionId, incoming]]),
    );

    expect(result[0]).toMatchObject({
      prompt: "preserve me",
      status: "completed",
      reviewState: "needs_review",
      updatedAt: "2026-09-02T00:00:00Z",
      lastMessage: incoming.lastMessage,
    });
  });

  it("preserves structural sharing when the lifecycle projection is unchanged", () => {
    const current = session({
      updatedAt: "2026-09-02T00:00:00Z",
      lastEventId: 12,
      lastMessage: {
        type: "assistant_message",
        preview: "done",
        timestamp: "2026-09-02T00:00:00Z",
      },
    });
    const snapshots = new Map([[current.agentSessionId, { ...current }]]);

    const result = applySessionLifecycleSnapshotToList([current], snapshots);

    expect(result[0]).toBe(current);
  });

  it("does not erase optional REST fields when a newer lifecycle snapshot omits them", () => {
    const current = session({
      reviewState: "needs_review",
      updatedAt: "2026-09-01T00:00:00Z",
      lastMessage: {
        type: "user_message",
        preview: "keep",
        timestamp: "2026-09-01T00:00:00Z",
      },
    });
    const incoming = {
      agentSessionId: current.agentSessionId,
      status: "completed" as const,
      createdAt: "2026-09-03T00:00:00Z",
    };

    const result = applySessionLifecycleSnapshotToList(
      [current],
      new Map([[incoming.agentSessionId, incoming]]),
    );

    expect(result[0]).toMatchObject({
      status: "completed",
      reviewState: "needs_review",
      lastMessage: current.lastMessage,
    });
  });

  it("applies a newer attention revision even when lifecycle timestamps are older", () => {
    const current = session({
      status: "running",
      updatedAt: "2026-09-03T00:00:00Z",
      lastEventId: 20,
      pendingAttentions: [{
        id: "input_request:req-10",
        sourceEventId: 10,
        sessionId: "session-a",
        kind: "input_request",
        requestedAt: "2026-09-01T00:00:00Z",
        title: "Question",
        body: "Old",
        requiresDetail: false,
      }],
      attentionRevision: 10,
    });
    const incoming = session({
      status: "completed",
      updatedAt: "2026-09-02T00:00:00Z",
      lastEventId: 19,
      pendingAttentions: [],
      attentionRevision: 11,
    });

    const [result] = applySessionLifecycleSnapshotToList(
      [current],
      new Map([[incoming.agentSessionId, incoming]]),
    );

    expect(result).toMatchObject({
      status: "running",
      updatedAt: "2026-09-03T00:00:00Z",
      pendingAttentions: [],
      attentionRevision: 11,
    });
  });

  it("does not regress attention or notice projections from a newer lifecycle snapshot", () => {
    const newestNotice = {
      id: "session-a:12",
      sourceEventId: 12,
      sessionId: "session-a",
      kind: "terminal" as const,
      title: "Newest",
      body: "Keep",
      createdAt: "2026-09-02T00:00:00Z",
    };
    const current = session({
      status: "running",
      updatedAt: "2026-09-02T00:00:00Z",
      lastEventId: 12,
      pendingAttentions: [],
      attentionRevision: 12,
      recentNotices: [newestNotice],
      notificationWatermark: 12,
      noticesTruncated: false,
    });
    const incoming = session({
      status: "completed",
      updatedAt: "2026-09-03T00:00:00Z",
      lastEventId: 13,
      pendingAttentions: [{
        id: "input_request:req-11",
        sourceEventId: 11,
        sessionId: "session-a",
        kind: "input_request",
        requestedAt: "2026-09-01T00:00:00Z",
        title: "Stale",
        body: "Do not restore",
        requiresDetail: false,
      }],
      attentionRevision: 11,
      recentNotices: [],
      notificationWatermark: 11,
      noticesTruncated: true,
    });

    const [result] = applySessionLifecycleSnapshotToList(
      [current],
      new Map([[incoming.agentSessionId, incoming]]),
    );

    expect(result).toMatchObject({
      status: "completed",
      updatedAt: "2026-09-03T00:00:00Z",
      pendingAttentions: [],
      attentionRevision: 12,
      recentNotices: [newestNotice],
      notificationWatermark: 12,
      noticesTruncated: false,
    });
  });
});

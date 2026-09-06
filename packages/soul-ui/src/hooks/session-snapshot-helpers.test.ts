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
});

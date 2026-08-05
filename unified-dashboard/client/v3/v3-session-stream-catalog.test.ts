import { describe, expect, it } from "vitest";
import type { CatalogState, SessionListStreamEvent, SessionSummary } from "@seosoyoung/soul-ui";

import {
  projectSessionListSnapshot,
  reconcileCanonicalReviewSessions,
} from "./v3-session-stream-catalog";

describe("v3 session_list catalog projection", () => {
  it("stores the full existing stream snapshot without replacing equal rows", () => {
    const current = session("same", "running");
    const catalog: CatalogState = {
      folders: [],
      sessions: {},
      sessionList: [current],
    };
    const event: SessionListStreamEvent = {
      type: "session_list",
      sessions: [{ ...current }],
      total: 1,
    };

    const projected = projectSessionListSnapshot(catalog, event);

    expect(projected).toBe(catalog);
    expect(projected.sessionList?.[0]).toBe(current);
  });

  it("normalizes wire rows and replaces only the changed session identity", () => {
    const unchanged = session("unchanged", "running");
    const changed = session("changed", "running");
    const catalog: CatalogState = {
      folders: [],
      sessions: {},
      sessionList: [unchanged, changed],
    };
    const event = {
      type: "session_list",
      sessions: [
        { ...unchanged },
        { agent_session_id: "changed", status: "completed", event_count: 0 },
      ],
      total: 2,
    } as unknown as SessionListStreamEvent;

    const projected = projectSessionListSnapshot(catalog, event);

    expect(projected).not.toBe(catalog);
    expect(projected.sessionList?.[0]).toBe(unchanged);
    expect(projected.sessionList?.[1]).not.toBe(changed);
    expect(projected.sessionList?.[1]).toMatchObject({
      agentSessionId: "changed",
      status: "completed",
    });
  });

  it("preserves an off-window review row when the latest session snapshot arrives", () => {
    const oldReview = reviewSession("old-review");
    const catalog: CatalogState = {
      folders: [],
      sessions: {},
      sessionList: [oldReview],
    };
    const event: SessionListStreamEvent = {
      type: "session_list",
      sessions: [session("recent", "running")],
      total: 1125,
    };

    const projected = projectSessionListSnapshot(catalog, event);

    expect(projected.sessionList?.map((item) => item.agentSessionId)).toEqual([
      "recent",
      "old-review",
    ]);
    expect(projected.sessionList?.[1]).toBe(oldReview);
  });

  it("lets the latest snapshot replace an overlapping acknowledged review row", () => {
    const catalog: CatalogState = {
      folders: [],
      sessions: {},
      sessionList: [reviewSession("reviewed")],
    };
    const event: SessionListStreamEvent = {
      type: "session_list",
      sessions: [{
        ...session("reviewed", "completed"),
        reviewState: "acknowledged",
      }],
      total: 1,
    };

    const projected = projectSessionListSnapshot(catalog, event);

    expect(projected.sessionList).toHaveLength(1);
    expect(projected.sessionList?.[0]?.reviewState).toBe("acknowledged");
  });
});

describe("canonical review queue reconciliation", () => {
  it("adds reviews outside the latest window and removes stale review membership", () => {
    const recent = session("recent", "running");
    const currentReview = reviewSession("current-review");
    const staleReview = reviewSession("stale-review");
    const oldReview = reviewSession("rank-1125");
    const catalog: CatalogState = {
      folders: [],
      sessions: {},
      sessionList: [recent, currentReview, staleReview],
    };

    const reconciled = reconcileCanonicalReviewSessions(catalog, [
      { ...currentReview },
      oldReview,
    ]);

    expect(reconciled.sessionList?.map((item) => item.agentSessionId)).toEqual([
      "recent",
      "current-review",
      "rank-1125",
    ]);
    expect(reconciled.sessionList?.[0]).toBe(recent);
    expect(reconciled.sessionList?.[1]).toBe(currentReview);
    expect(reconciled.sessionList?.[2]).toEqual(oldReview);
  });
});

function session(id: string, status: SessionSummary["status"]): SessionSummary {
  return { agentSessionId: id, status, eventCount: 0 };
}

function reviewSession(id: string): SessionSummary {
  return {
    ...session(id, "completed"),
    reviewState: "needs_review",
  };
}

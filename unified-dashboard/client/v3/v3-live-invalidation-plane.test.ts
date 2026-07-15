import { beforeEach, describe, expect, it } from "vitest";

import {
  acceptV3SessionStreamEvent,
  getV3InvalidationSnapshot,
  invalidateV3,
  resetV3InvalidationForTest,
  selectV3InvalidationKey,
  trackedV3PageIds,
} from "./v3-live-invalidation-plane";

describe("v3 live invalidation plane", () => {
  beforeEach(() => resetV3InvalidationForTest());

  it("normalizes session, catalog, runbook, custom view, replay, page, and local changes", () => {
    acceptV3SessionStreamEvent({
      type: "session_updated",
      agent_session_id: "session-a",
      status: "running",
      updated_at: "2026-07-15T00:00:00Z",
    });
    acceptV3SessionStreamEvent({
      type: "runbook_updated",
      runbookId: "rb-a",
      boardItemId: "runbook:rb-a",
    });
    acceptV3SessionStreamEvent({
      type: "catalog_updated",
      catalog: { folders: [], sessions: {} } as never,
    });
    acceptV3SessionStreamEvent({
      type: "custom_view_updated",
      customViewId: "cv-a",
      boardItemId: "custom_view:cv-a",
      revision: 2,
    });
    acceptV3SessionStreamEvent({ type: "replay_gap", latest_id: 9, instance_id: "orch-a" });
    invalidateV3("page");
    invalidateV3("local");

    const snapshot = getV3InvalidationSnapshot();
    expect(selectV3InvalidationKey(snapshot, ["session"])).toBe(1);
    expect(selectV3InvalidationKey(snapshot, ["catalog"])).toBe(1);
    expect(selectV3InvalidationKey(snapshot, ["runbook"])).toBe(1);
    expect(selectV3InvalidationKey(snapshot, ["custom_view"])).toBe(1);
    expect(selectV3InvalidationKey(snapshot, ["replay"])).toBe(1);
    expect(selectV3InvalidationKey(snapshot, ["page", "local"])).toBe(2);
  });

  it("does not invalidate on session_list or stream_meta handshakes", () => {
    acceptV3SessionStreamEvent({ type: "session_list", sessions: [], total: 0 });
    acceptV3SessionStreamEvent({ type: "stream_meta", instance_id: "orch-a", latest_id: 0 });

    expect(getV3InvalidationSnapshot().revision).toBe(0);
  });

  it("tracks only the deduplicated page ids currently loaded by v3", () => {
    expect(trackedV3PageIds([
      "daily-a",
      "task-a",
      null,
      "task-a",
      "",
      undefined,
      "project-a",
    ])).toEqual(["daily-a", "project-a", "task-a"]);
  });
});

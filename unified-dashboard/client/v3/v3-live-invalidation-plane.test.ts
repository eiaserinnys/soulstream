import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  acceptV3SessionStreamEvent,
  getV3PageInvalidationKey,
  getV3InvalidationSnapshot,
  invalidateV3,
  resetV3InvalidationForTest,
  selectV3InvalidationKey,
  selectV3PlannerInvalidationKeys,
  subscribeV3PageInvalidation,
  trackedV3PageIds,
} from "./v3-live-invalidation-plane";

describe("v3 live invalidation plane", () => {
  beforeEach(() => resetV3InvalidationForTest());

  it("routes page changes to the matching page and the starred collection", () => {
    const pageAListener = vi.fn();
    const pageBListener = vi.fn();
    const unsubscribeA = subscribeV3PageInvalidation(["page-a"], pageAListener);
    const unsubscribeB = subscribeV3PageInvalidation(["page-b"], pageBListener);

    acceptV3SessionStreamEvent({
      type: "session_updated",
      agent_session_id: "session-a",
      status: "running",
      updated_at: "2026-07-15T00:00:00Z",
    });
    acceptV3SessionStreamEvent({
      type: "task_updated",
      taskId: "rb-a",
      boardItemId: "task:rb-a",
    });
    acceptV3SessionStreamEvent({
      type: "catalog_updated",
      folders: [],
      sessions_delta: {},
      board_items_delta: {},
    });
    acceptV3SessionStreamEvent({
      type: "custom_view_updated",
      customViewId: "cv-a",
      boardItemId: "custom_view:cv-a",
      revision: 2,
    });
    acceptV3SessionStreamEvent({ type: "replay_gap", latest_id: 9, instance_id: "orch-a" });
    const beforePageUpdate = selectV3PlannerInvalidationKeys(getV3InvalidationSnapshot());
    acceptV3SessionStreamEvent({ type: "page_updated", page_id: "page-a", version: 7 });

    const snapshot = getV3InvalidationSnapshot();
    expect(selectV3InvalidationKey(snapshot, ["session_updated"])).toBe(1);
    expect(selectV3InvalidationKey(snapshot, ["catalog"])).toBe(1);
    expect(selectV3InvalidationKey(snapshot, ["task"])).toBe(1);
    expect(selectV3InvalidationKey(snapshot, ["custom_view"])).toBe(1);
    expect(selectV3InvalidationKey(snapshot, ["replay"])).toBe(1);
    expect(pageAListener).toHaveBeenCalledOnce();
    expect(pageBListener).not.toHaveBeenCalled();
    expect(getV3PageInvalidationKey(["page-a"])).toBe(1);
    expect(getV3PageInvalidationKey(["page-b"])).toBe(0);
    expect(selectV3PlannerInvalidationKeys(snapshot)).toMatchObject({
      daily: beforePageUpdate.daily,
      project: beforePageUpdate.project,
      starred: beforePageUpdate.starred + 1,
    });
    unsubscribeA();
    unsubscribeB();
  });

  it("invalidates only planner queries that consume each event kind", () => {
    const initial = selectV3PlannerInvalidationKeys(getV3InvalidationSnapshot());

    acceptV3SessionStreamEvent({
      type: "session_updated",
      agent_session_id: "session-a",
      status: "running",
      updated_at: "2026-07-15T00:00:00Z",
    });
    acceptV3SessionStreamEvent({
      type: "metadata_updated",
      session_id: "session-a",
      entry: { type: "display", value: "same" },
      metadata: [],
    });
    acceptV3SessionStreamEvent({
      type: "catalog_updated",
      catalog: { folders: [], sessions: {} } as never,
    });
    expect(selectV3PlannerInvalidationKeys(getV3InvalidationSnapshot())).toEqual(initial);

    acceptV3SessionStreamEvent({
      type: "session_created",
      session: { agentSessionId: "session-b" } as never,
    });
    expect(selectV3PlannerInvalidationKeys(getV3InvalidationSnapshot())).toEqual({
      daily: 1,
      project: 1,
      starred: 1,
      runHistory: 1,
      pageDetail: 0,
    });

    acceptV3SessionStreamEvent({
      type: "task_updated",
      taskId: "rb-a",
      boardItemId: "task:rb-a",
    });
    expect(selectV3PlannerInvalidationKeys(getV3InvalidationSnapshot())).toEqual({
      daily: 2,
      project: 2,
      starred: 2,
      runHistory: 1,
      pageDetail: 0,
    });

    acceptV3SessionStreamEvent({ type: "session_deleted", agent_session_id: "session-b" });
    expect(selectV3PlannerInvalidationKeys(getV3InvalidationSnapshot())).toEqual({
      daily: 3,
      project: 3,
      starred: 3,
      runHistory: 2,
      pageDetail: 0,
    });

    acceptV3SessionStreamEvent({ type: "page_updated", page_id: "page-a", version: 8 });
    expect(selectV3PlannerInvalidationKeys(getV3InvalidationSnapshot())).toEqual({
      daily: 3,
      project: 3,
      starred: 4,
      runHistory: 2,
      pageDetail: 0,
    });
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

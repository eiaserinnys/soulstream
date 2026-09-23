import { describe, expect, it } from "vitest";

import type { PageDto } from "@seosoyoung/soul-ui/page";

import type { PlannerTask } from "./planner-data";
import {
  applyStarredPlannerTaskChanges,
  isStarredPlannerPageCurrent,
  mergeStarredPlannerTasks,
} from "./starred-planner-collection";

describe("starred planner collection", () => {
  it("merges full and fallback entries by page identity", () => {
    const full = plannerTask("task-a", "업무 A");
    const updatedPage = page("task-a", "업무 A 수정");

    expect(mergeStarredPlannerTasks([full], [updatedPage])).toEqual([updatedPage]);
  });

  it("keeps full task data while applying a starred page update", () => {
    const full = plannerTask("task-a", "업무 A");
    const updatedPage = page("task-a", "업무 A 수정");

    const result = applyStarredPlannerTaskChanges([full], [{ page: updatedPage, starred: true }]);

    expect(result).toEqual([{ ...full, page: updatedPage }]);
  });

  it("adds and removes fallback page entries", () => {
    const added = page("task-b", "업무 B");

    expect(applyStarredPlannerTaskChanges([], [{ page: added, starred: true }])).toEqual([added]);
    expect(applyStarredPlannerTaskChanges([added], [{ page: added, starred: false }])).toEqual([]);
  });

  it("rejects a load-more response after the first-page cursor or order changes", () => {
    const first = plannerTask("task-a", "업무 A");
    const second = plannerTask("task-b", "업무 B");
    const current = { items: [first, second], nextCursor: "cursor-new" };

    expect(isStarredPlannerPageCurrent(current, ["task-a", "task-b"], "cursor-new")).toBe(true);
    expect(isStarredPlannerPageCurrent(current, ["task-a", "task-b"], "cursor-old")).toBe(false);
    expect(isStarredPlannerPageCurrent(current, ["task-b", "task-a"], "cursor-new")).toBe(false);
  });
});

function plannerTask(id: string, title: string): PlannerTask {
  return {
    page: page(id, title),
    blocks: [],
    stateVector: "",
    taskId: id,
    task: null,
    status: "open",
    assignee: "담당 미확인",
    contextCount: 0,
    progress: null,
    projectPageId: null,
    sessionIds: [],
    mountedDocuments: [],
  };
}

function page(id: string, title: string): PageDto {
  return {
    id,
    title,
    daily_date: null,
    archived: false,
    metadata: { starred: true },
    version: 1,
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
  };
}

import { describe, expect, it } from "vitest";

import {
  planTaskProjectMountBackfill,
  type TaskProjectMountInventoryRow,
} from "../src/tasks/task_project_mount_backfill_plan.js";

describe("planTaskProjectMountBackfill", () => {
  it("excludes manually corrected and duplicate physical mounts from creation candidates", () => {
    const plan = planTaskProjectMountBackfill([
      row({ taskId: "5ce60d5a-manually-corrected", physicalMountCount: 1 }),
      row({ taskId: "duplicate", physicalMountCount: 2 }),
      row({ taskId: "missing" }),
    ]);

    expect(plan.create.map((entry) => entry.taskId)).toEqual(["missing"]);
    expect(plan.alreadyMounted.map((entry) => entry.taskId)).toEqual([
      "5ce60d5a-manually-corrected",
      "duplicate",
    ]);
    expect(plan.duplicate.map((entry) => entry.taskId)).toEqual(["duplicate"]);
  });

  it("holds unresolved exact-title blocks for inspection instead of proposing a duplicate", () => {
    const plan = planTaskProjectMountBackfill([
      row({ taskId: "unresolved", exactTitleBlockCount: 1 }),
      row({ taskId: "missing" }),
    ]);

    expect(plan.create.map((entry) => entry.taskId)).toEqual(["missing"]);
    expect(plan.inspect.map((entry) => entry.taskId)).toEqual(["unresolved"]);
  });
});

function row(
  input: Partial<TaskProjectMountInventoryRow> & { taskId: string },
): TaskProjectMountInventoryRow {
  return {
    taskId: input.taskId,
    taskPageId: input.taskPageId ?? `task-${input.taskId}`,
    title: input.title ?? `Task ${input.taskId}`,
    folderId: input.folderId ?? "folder-a",
    projectPageId: input.projectPageId ?? "project-a",
    physicalMountCount: input.physicalMountCount ?? 0,
    exactTitleBlockCount: input.exactTitleBlockCount ?? 0,
  };
}

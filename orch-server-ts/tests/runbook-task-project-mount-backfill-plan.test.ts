import { describe, expect, it } from "vitest";

import {
  planTaskProjectMountBackfill,
  type TaskProjectMountInventoryRow,
} from "../src/runbooks/runbook_task_project_mount_backfill_plan.js";

describe("planTaskProjectMountBackfill", () => {
  it("excludes manually corrected and duplicate physical mounts from creation candidates", () => {
    const plan = planTaskProjectMountBackfill([
      row({ runbookId: "5ce60d5a-manually-corrected", physicalMountCount: 1 }),
      row({ runbookId: "duplicate", physicalMountCount: 2 }),
      row({ runbookId: "missing" }),
    ]);

    expect(plan.create.map((entry) => entry.runbookId)).toEqual(["missing"]);
    expect(plan.alreadyMounted.map((entry) => entry.runbookId)).toEqual([
      "5ce60d5a-manually-corrected",
      "duplicate",
    ]);
    expect(plan.duplicate.map((entry) => entry.runbookId)).toEqual(["duplicate"]);
  });

  it("holds unresolved exact-title blocks for inspection instead of proposing a duplicate", () => {
    const plan = planTaskProjectMountBackfill([
      row({ runbookId: "unresolved", exactTitleBlockCount: 1 }),
      row({ runbookId: "missing" }),
    ]);

    expect(plan.create.map((entry) => entry.runbookId)).toEqual(["missing"]);
    expect(plan.inspect.map((entry) => entry.runbookId)).toEqual(["unresolved"]);
  });
});

function row(
  input: Partial<TaskProjectMountInventoryRow> & { runbookId: string },
): TaskProjectMountInventoryRow {
  return {
    runbookId: input.runbookId,
    taskPageId: input.taskPageId ?? `task-${input.runbookId}`,
    title: input.title ?? `Task ${input.runbookId}`,
    folderId: input.folderId ?? "folder-a",
    projectPageId: input.projectPageId ?? "project-a",
    physicalMountCount: input.physicalMountCount ?? 0,
    exactTitleBlockCount: input.exactTitleBlockCount ?? 0,
  };
}

import { describe, expect, it } from "vitest";

import { planTaskCrudSyncAudit } from "../src/runbooks/runbook_task_crud_sync_audit_plan.js";

describe("task CRUD sync audit plan", () => {
  it("classifies missing, wrong, duplicate, and archived mount residue independently", () => {
    const plan = planTaskCrudSyncAudit({
      activeRows: [
        active("missing", "project-a", null, 0),
        active("wrong", "project-a", "project-b", 1),
        active("duplicate", "project-a", "project-a", 2),
        active("healthy", "project-a", "project-a", 1),
      ],
      archivedRows: [{
        runbookId: "archived",
        taskPageId: "page-archived",
        title: "archived",
        sourcePageId: "daily-page",
        sourceKind: "daily",
        mountCount: 1,
      }],
    });

    expect(plan.activeTaskCount).toBe(4);
    expect(plan.activeProjectMountMissing.map((item) => item.runbookId)).toEqual([
      "missing",
      "wrong",
    ]);
    expect(plan.activeWrongProjectMount.map((item) => item.runbookId)).toEqual(["wrong"]);
    expect(plan.activeDuplicateProjectMount.map((item) => item.runbookId)).toEqual(["duplicate"]);
    expect(plan.archivedMountResidue).toEqual([
      expect.objectContaining({ runbookId: "archived", sourceKind: "daily" }),
    ]);
  });

  it("keeps all actual project pages for one task in a single finding", () => {
    const plan = planTaskCrudSyncAudit({
      activeRows: [
        active("moved", "project-b", "project-a", 1),
        active("moved", "project-b", "project-b", 1),
      ],
      archivedRows: [],
    });

    expect(plan.activeProjectMountMissing).toEqual([]);
    expect(plan.activeWrongProjectMount).toEqual([expect.objectContaining({
      runbookId: "moved",
      actualProjectMounts: [
        { sourceProjectPageId: "project-a", mountCount: 1 },
        { sourceProjectPageId: "project-b", mountCount: 1 },
      ],
    })]);
  });
});

function active(
  runbookId: string,
  expectedProjectPageId: string,
  sourceProjectPageId: string | null,
  mountCount: number,
) {
  return {
    runbookId,
    taskPageId: `page-${runbookId}`,
    title: runbookId,
    expectedFolderId: "folder-a",
    expectedProjectPageId,
    sourceProjectPageId,
    mountCount,
  };
}

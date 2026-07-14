import { describe, expect, it, vi } from "vitest";

import {
  PlannerTaskCreationError,
  createPlannerTask,
  type PlannerTaskCreationPort,
} from "./planner-task-creation";

describe("createPlannerTask", () => {
  it("creates the mounted page, runbook reference, and project mount in order", async () => {
    const calls: string[] = [];
    const port: PlannerTaskCreationPort = {
      createTaskPage: vi.fn(async () => {
        calls.push("page");
        return { pageId: "page-task" };
      }),
      createRunbook: vi.fn(async () => {
        calls.push("runbook");
        return { runbookId: "rb-task" };
      }),
      addPrimaryRunbookReference: vi.fn(async () => { calls.push("reference"); }),
      mountPage: vi.fn(async () => { calls.push("project-mount"); }),
    };

    await expect(createPlannerTask({
      title: "새 업무",
      description: "## 첫 설명\n\n업무 배경",
      dailyPageId: "daily",
      projectPageId: "project",
      folderId: "folder",
    }, port)).resolves.toEqual({ pageId: "page-task", runbookId: "rb-task" });

    expect(calls).toEqual(["page", "runbook", "reference", "project-mount"]);
    expect(port.createTaskPage).toHaveBeenCalledWith({
      title: "새 업무",
      description: "## 첫 설명\n\n업무 배경",
      sourcePageId: "daily",
    });
    expect(port.addPrimaryRunbookReference).toHaveBeenCalledWith({
      pageId: "page-task",
      runbookId: "rb-task",
    });
    expect(port.mountPage).toHaveBeenCalledWith({
      sourcePageId: "project",
      title: "새 업무",
    });
  });

  it("reports the exact failed phase", async () => {
    const port: PlannerTaskCreationPort = {
      createTaskPage: vi.fn(async () => ({ pageId: "page-task" })),
      createRunbook: vi.fn(async () => { throw new Error("offline"); }),
      addPrimaryRunbookReference: vi.fn(),
      mountPage: vi.fn(),
    };

    const failure = await createPlannerTask({
      title: "새 업무",
      description: "",
      dailyPageId: "daily",
      projectPageId: "project",
      folderId: "folder",
    }, port).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PlannerTaskCreationError);
    expect(failure).toMatchObject({ phase: "runbook" });
    expect(port.addPrimaryRunbookReference).not.toHaveBeenCalled();
  });
});

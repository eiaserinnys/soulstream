import { describe, expect, it, vi } from "vitest";

import {
  PlannerTaskCreationError,
  createPlannerTask,
  type PlannerTaskCreationPort,
} from "./planner-task-creation";

describe("createPlannerTask", () => {
  it("creates one task identity, then mounts the same page on daily and project", async () => {
    const calls: string[] = [];
    const port: PlannerTaskCreationPort = {
      createTaskIdentity: vi.fn(async () => {
        calls.push("identity");
        return { id: "task-uuid" };
      }),
      mountPage: vi.fn(async ({ sourcePageId }) => { calls.push(`${sourcePageId}-mount`); }),
    };

    await expect(createPlannerTask({
      title: "새 업무",
      description: "## 첫 설명\n\n업무 배경",
      dailyPageId: "daily",
      projectPageId: "project",
      folderId: "folder",
    }, port)).resolves.toEqual({ pageId: "task-uuid", runbookId: "task-uuid" });

    expect(calls).toEqual(["identity", "daily-mount", "project-mount"]);
    expect(port.createTaskIdentity).toHaveBeenCalledWith({
      title: "새 업무",
      description: "## 첫 설명\n\n업무 배경",
      folderId: "folder",
    });
    expect(port.mountPage).toHaveBeenNthCalledWith(1, {
      sourcePageId: "daily",
      title: "새 업무",
    });
    expect(port.mountPage).toHaveBeenNthCalledWith(2, {
      sourcePageId: "project",
      title: "새 업무",
    });
  });

  it("reports the exact failed phase", async () => {
    const port: PlannerTaskCreationPort = {
      createTaskIdentity: vi.fn(async () => { throw new Error("offline"); }),
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
    expect(port.mountPage).not.toHaveBeenCalled();
  });
});

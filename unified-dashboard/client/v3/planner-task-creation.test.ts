import { describe, expect, it, vi } from "vitest";

import {
  PlannerTaskCreationError,
  createPlannerTask,
  plannerTaskCreationErrorLabel,
  type PlannerTaskCreationPort,
} from "./planner-task-creation";

describe("createPlannerTask", () => {
  it("creates one task identity and leaves the canonical project mount to the server", async () => {
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
      folderId: "folder",
      initialContext: {
        guidance: "초기 지침",
        atomReferences: [],
      },
    }, port)).resolves.toEqual({ pageId: "task-uuid", taskId: "task-uuid" });

    expect(calls).toEqual(["identity", "daily-mount"]);
    expect(port.createTaskIdentity).toHaveBeenCalledWith({
      title: "새 업무",
      description: "## 첫 설명\n\n업무 배경",
      folderId: "folder",
      initialContext: {
        guidance: "초기 지침",
        atomReferences: [],
      },
    });
    expect(port.mountPage).toHaveBeenNthCalledWith(1, {
      sourcePageId: "daily",
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
      folderId: "folder",
    }, port).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PlannerTaskCreationError);
    expect(failure).toMatchObject({ phase: "task" });
    expect(port.mountPage).not.toHaveBeenCalled();
  });

  it("owns the user-facing label for each creation phase", () => {
    expect(plannerTaskCreationErrorLabel(new PlannerTaskCreationError("page", "offline")))
      .toBe("업무 페이지 생성");
    expect(plannerTaskCreationErrorLabel(new Error("offline"))).toBe("새 업무 생성");
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  PlannerFolderCreationError,
  createPlannerFolder,
  plannerFolderCreationErrorLabel,
  type PlannerFolderCreationPort,
} from "./planner-folder-creation";

describe("createPlannerFolder", () => {
  it("creates one task identity and leaves the canonical project mount to the server", async () => {
    const calls: string[] = [];
    const port: PlannerFolderCreationPort = {
      createFolderIdentity: vi.fn(async () => {
        calls.push("identity");
        return { id: "folder-uuid", pageId: "page-uuid" };
      }),
      mountPage: vi.fn(async ({ sourcePageId }) => { calls.push(`${sourcePageId}-mount`); }),
    };

    await expect(createPlannerFolder({
      title: "새 업무",
      description: "## 첫 설명\n\n업무 배경",
      dailyPageId: "daily",
      folderId: "folder",
      initialContext: {
        guidance: "초기 지침",
        atomReferences: [],
      },
    }, port)).resolves.toEqual({ pageId: "page-uuid", folderId: "folder-uuid" });

    expect(calls).toEqual(["identity", "daily-mount"]);
    expect(port.createFolderIdentity).toHaveBeenCalledWith({
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
    const port: PlannerFolderCreationPort = {
      createFolderIdentity: vi.fn(async () => { throw new Error("offline"); }),
      mountPage: vi.fn(),
    };

    const failure = await createPlannerFolder({
      title: "새 업무",
      description: "",
      dailyPageId: "daily",
      folderId: "folder",
    }, port).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PlannerFolderCreationError);
    expect(failure).toMatchObject({ phase: "folder" });
    expect(port.mountPage).not.toHaveBeenCalled();
  });

  it("owns the user-facing label for each creation phase", () => {
    expect(plannerFolderCreationErrorLabel(new PlannerFolderCreationError("page", "offline")))
      .toBe("업무 페이지 생성");
    expect(plannerFolderCreationErrorLabel(new Error("offline"))).toBe("새 업무 생성");
  });
});

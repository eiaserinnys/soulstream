import { describe, expect, it } from "vitest";

import {
  classifyMountedPage,
  derivePlannerTaskStatus,
  plannerStatusPresentation,
  resolveProjectFolderId,
} from "./planner-model";

describe("classifyMountedPage", () => {
  it("classifies a page with a primary task_ref as a task", () => {
    expect(classifyMountedPage([
      block("paragraph", {}),
      block("task_ref", { taskId: "rb-1", primary: true }),
    ])).toEqual({ kind: "task", taskId: "rb-1" });
  });

  it("classifies pages without a valid primary reference as documents", () => {
    expect(classifyMountedPage([block("paragraph", {})])).toEqual({ kind: "document" });
    expect(classifyMountedPage([
      block("task_ref", { taskId: "rb-secondary", primary: false }),
    ])).toEqual({ kind: "document" });
  });
});

describe("project folder bridge", () => {
  it("resolves only the explicit immutable project page binding", () => {
    const folders = [
      { id: "folder-explicit", name: "다른 프로젝트", sortOrder: 0, projectPageId: "page-explicit" },
      { id: "folder-soul", name: "✨ 소울스트림", sortOrder: 1, projectPageId: "page-soul" },
    ];
    expect(resolveProjectFolderId({ id: "page-explicit" }, folders))
      .toBe("folder-explicit");
    expect(resolveProjectFolderId({ id: "missing" }, folders)).toBeNull();
  });
});

describe("planner task status", () => {
  it("derives review and in-progress states from open task items", () => {
    expect(derivePlannerTaskStatus(snapshot("open", ["pending"]))).toBe("open");
    expect(derivePlannerTaskStatus(snapshot("open", ["in_progress"]))).toBe("in_progress");
    expect(derivePlannerTaskStatus(snapshot("open", ["in_progress", "review"]))).toBe("review");
    expect(derivePlannerTaskStatus(snapshot("completed", ["review"]))).toBe("completed");
  });

  it("maps canonical states to the mockup chips", () => {
    expect(plannerStatusPresentation("open")).toMatchObject({ icon: "○", label: "Open" });
    expect(plannerStatusPresentation("in_progress")).toMatchObject({ icon: "●", label: "진행" });
    expect(plannerStatusPresentation("review")).toMatchObject({ icon: "◆", label: "검수" });
    expect(plannerStatusPresentation("completed")).toMatchObject({ icon: "✓", label: "완료" });
  });
});

function block(blockType: string, properties: Record<string, unknown>) {
  return {
    id: `block-${blockType}`,
    page_id: "page-1",
    parent_id: null,
    position_key: "a0",
    block_type: blockType,
    text: "",
    properties,
    collapsed: false,
  };
}

function snapshot(status: string, itemStatuses: string[]) {
  return {
    task: { status },
    items: itemStatuses.map((itemStatus) => ({ status: itemStatus })),
  };
}

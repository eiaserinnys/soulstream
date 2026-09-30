import { describe, expect, it } from "vitest";

import {
  derivePlannerFolderStatus,
  plannerStatusPresentation,
  resolveProjectFolderId,
} from "./planner-model";

describe("project folder bridge", () => {
  it("resolves only the explicit immutable project page binding", () => {
    const folders = [
      { checklistEnabled: false, status: "open" as const, version: 1, archived: false, id: "folder-explicit", name: "다른 프로젝트", sortOrder: 0, projectPageId: "page-explicit" },
      { checklistEnabled: false, status: "open" as const, version: 1, archived: false, id: "folder-soul", name: "✨ 소울스트림", sortOrder: 1, projectPageId: "page-soul" },
    ];
    expect(resolveProjectFolderId({ id: "page-explicit" }, folders))
      .toBe("folder-explicit");
    expect(resolveProjectFolderId({ id: "missing" }, folders)).toBeNull();
  });
});

describe("planner task status", () => {
  it("derives review and in-progress states from open task items", () => {
    expect(derivePlannerFolderStatus(snapshot("open", ["todo"]))).toBe("open");
    expect(derivePlannerFolderStatus(snapshot("open", ["running"]))).toBe("in_progress");
    expect(derivePlannerFolderStatus(snapshot("open", ["in_progress", "review"]))).toBe("review");
    expect(derivePlannerFolderStatus(snapshot("completed", ["review"]))).toBe("completed");
  });

  it("maps canonical states to the mockup chips", () => {
    expect(plannerStatusPresentation("open")).toMatchObject({ icon: "○", label: "Open" });
    expect(plannerStatusPresentation("in_progress")).toMatchObject({ icon: "●", label: "진행" });
    expect(plannerStatusPresentation("review")).toMatchObject({ icon: "◆", label: "검수" });
    expect(plannerStatusPresentation("completed")).toMatchObject({ icon: "✓", label: "완료" });
  });
});

function snapshot(status: "open" | "completed", itemStatuses: string[]) {
  return {
    folder: { status },
    items: itemStatuses.map((itemStatus) => ({ status: itemStatus })),
  };
}

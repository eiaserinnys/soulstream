import { describe, expect, it } from "vitest";

import { planFolderProjectBackfill } from "../src/folders/folder_project_backfill_plan.js";

describe("folder project backfill plan", () => {
  it("reports 23 reuse and 55 same-ID creates, including the title-mismatch decision", () => {
    const folders = Array.from({ length: 78 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: index === 0 ? "✨ 소울스트림" : `프로젝트 ${index}`,
    }));
    const pages = folders.slice(0, 23).map((folder, index) => ({
      id: `page-${index}`,
      title: index === 0 ? "소울스트림" : folder.name,
      daily: false,
      taskIdentity: false,
      boundFolderId: null,
    }));

    const plan = planFolderProjectBackfill(folders, pages);

    expect(plan.reuse).toHaveLength(23);
    expect(plan.create).toHaveLength(55);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.reuse[0]).toMatchObject({
      folderName: "✨ 소울스트림",
      pageTitle: "소울스트림",
      disposition: "folder-title-wins",
    });
    expect(plan.create.every((entry) => entry.folderId === entry.pageId)).toBe(true);
  });
});

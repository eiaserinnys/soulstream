import { describe, expect, it } from "vitest";
import type { CatalogFolder } from "@seosoyoung/soul-ui";

import { taskProjectFolderOptions } from "./task-project-targets";

describe("task project targets", () => {
  it("reuses folder tree ordering while keeping only bounded project identities", () => {
    const folders = [
      folder("root", "프로젝트", "project-root"),
      folder("child", "하위 프로젝트", "project-child", "root"),
      folder("plain", "일반 폴더", null),
      folder("current", "현재 프로젝트", "project-current"),
    ];

    expect(taskProjectFolderOptions(folders, "current").map(({ folder: item, depth }) => [
      item.id,
      item.projectPageId,
      depth,
    ])).toEqual([
      ["root", "project-root", 0],
      ["child", "project-child", 1],
    ]);
  });
});

function folder(
  id: string,
  name: string,
  projectPageId: string | null,
  parentFolderId: string | null = null,
): CatalogFolder {
  return { id, name, sortOrder: 0, parentFolderId, projectPageId };
}

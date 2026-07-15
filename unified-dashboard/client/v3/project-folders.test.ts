import { describe, expect, it } from "vitest";
import type { CatalogFolder } from "@seosoyoung/soul-ui";

import { flattenProjectFolders } from "./project-folders";

describe("project folder tree", () => {
  it("keeps every catalog folder and renders parent-child depth in sort order", () => {
    const folders: CatalogFolder[] = [
      folder("child-b", "B", 2, "root"),
      folder("root", "✨ 프로젝트", 1),
      folder("child-a", "A", 1, "root"),
      folder("orphan", "고아", 3, "missing"),
    ];

    expect(flattenProjectFolders(folders).map(({ folder: item, depth }) => [item.id, depth]))
      .toEqual([
        ["root", 0],
        ["child-a", 1],
        ["child-b", 1],
        ["orphan", 0],
      ]);
  });

  it("returns all 78 folders without pagination", () => {
    const folders = Array.from({ length: 78 }, (_, index) => folder(`folder-${index}`, `${index}`, index));
    expect(flattenProjectFolders(folders)).toHaveLength(78);
  });
});

function folder(id: string, name: string, sortOrder: number, parentFolderId: string | null = null): CatalogFolder {
  return { id, name, sortOrder, parentFolderId };
}

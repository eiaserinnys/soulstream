import { describe, expect, it } from "vitest";
import type { CatalogFolder } from "@seosoyoung/soul-ui";

import { buildProjectFolderTree, flattenProjectFolders } from "./project-folders";

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

  it("keeps child structure available while callers decide which branches are visible", () => {
    const folders: CatalogFolder[] = [
      folder("root", "Root", 0),
      folder("child", "Child", 0, "root"),
      folder("grandchild", "Grandchild", 0, "child"),
    ];

    const [root] = buildProjectFolderTree(folders);

    expect(root).toMatchObject({
      folder: { id: "root" },
      children: [{ folder: { id: "child" }, children: [{ folder: { id: "grandchild" } }] }],
    });
  });
});

function folder(id: string, name: string, sortOrder: number, parentFolderId: string | null = null): CatalogFolder {
  return { id, name, sortOrder, parentFolderId };
}

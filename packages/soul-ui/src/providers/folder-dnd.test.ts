import { describe, expect, it } from "vitest";

import { buildFolderMoveToRootItems, buildFolderReorderItems } from "./folder-dnd";

describe("buildFolderReorderItems", () => {
  it("reorders folders inside the same parent", () => {
    expect(
      buildFolderReorderItems({
        activeId: "child-b",
        overId: "child-a",
        activeParentFolderId: "root",
        overParentFolderId: "root",
        activeSiblingIds: ["child-a", "child-b", "child-c"],
        overSiblingIds: ["child-a", "child-b", "child-c"],
        overChildIds: [],
      }),
    ).toEqual([
      { id: "child-b", sortOrder: 0, parentFolderId: "root" },
      { id: "child-a", sortOrder: 1, parentFolderId: "root" },
      { id: "child-c", sortOrder: 2, parentFolderId: "root" },
    ]);
  });

  it("moves a folder under another folder and keeps both sibling groups ordered", () => {
    expect(
      buildFolderReorderItems({
        activeId: "child-a",
        overId: "root-b",
        activeParentFolderId: "root-a",
        overParentFolderId: null,
        activeSiblingIds: ["child-a", "child-b"],
        overSiblingIds: ["root-a", "root-b"],
        overChildIds: ["root-b-child"],
      }),
    ).toEqual([
      { id: "child-b", sortOrder: 0, parentFolderId: "root-a" },
      { id: "root-b-child", sortOrder: 0, parentFolderId: "root-b" },
      { id: "child-a", sortOrder: 1, parentFolderId: "root-b" },
    ]);
  });

  it("does not client-block cycle attempts so the server can reject and trigger rollback", () => {
    expect(
      buildFolderReorderItems({
        activeId: "root-a",
        overId: "child-a",
        activeParentFolderId: null,
        overParentFolderId: "root-a",
        activeSiblingIds: ["root-a", "root-b"],
        overSiblingIds: ["child-a"],
        overChildIds: [],
      }),
    ).toEqual([
      { id: "root-b", sortOrder: 0, parentFolderId: null },
      { id: "root-a", sortOrder: 0, parentFolderId: "child-a" },
    ]);
  });

  it("promotes a child to the root drop surface while preserving both sibling groups", () => {
    expect(buildFolderMoveToRootItems({
      activeId: "child-a",
      activeParentFolderId: "root-a",
      activeSiblingIds: ["child-a", "child-b"],
      rootSiblingIds: ["root-a", "root-b"],
    })).toEqual([
      { id: "child-b", sortOrder: 0, parentFolderId: "root-a" },
      { id: "root-a", sortOrder: 0, parentFolderId: null },
      { id: "root-b", sortOrder: 1, parentFolderId: null },
      { id: "child-a", sortOrder: 2, parentFolderId: null },
    ]);
  });
});

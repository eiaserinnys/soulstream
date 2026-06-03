import { describe, expect, it } from "vitest";

import type { CatalogState } from "../shared/types";
import {
  getChildFolders,
  getFolderBreadcrumbs,
  getFolderDirectChildCount,
  getRootFolders,
} from "./board-workspace-helpers";

const catalog: CatalogState = {
  folders: [
    { id: "root-a", name: "Root A", sortOrder: 0, parentFolderId: null },
    { id: "root-b", name: "Root B", sortOrder: 1, parentFolderId: null },
    { id: "child-a", name: "Child A", sortOrder: 0, parentFolderId: "root-a" },
    { id: "child-b", name: "Child B", sortOrder: 1, parentFolderId: "root-a" },
    { id: "grandchild", name: "Grandchild", sortOrder: 0, parentFolderId: "child-a" },
  ],
  sessions: {
    "sess-root": { folderId: "root-a", displayName: "Root Session" },
    "sess-child": { folderId: "child-a", displayName: "Child Session" },
    "sess-grand": { folderId: "grandchild", displayName: "Grand Session" },
  },
};

describe("board workspace folder helpers", () => {
  it("getChildFolders returns direct child folders only", () => {
    expect(getChildFolders(catalog.folders, "root-a").map((f) => f.id)).toEqual([
      "child-a",
      "child-b",
    ]);
  });

  it("getRootFolders excludes nested folders", () => {
    expect(getRootFolders(catalog.folders).map((f) => f.id)).toEqual([
      "root-a",
      "root-b",
    ]);
  });

  it("getFolderBreadcrumbs returns root-to-current path", () => {
    expect(getFolderBreadcrumbs(catalog.folders, "grandchild").map((f) => f.id)).toEqual([
      "root-a",
      "child-a",
      "grandchild",
    ]);
  });

  it("getFolderDirectChildCount counts only direct sessions and child folders", () => {
    expect(getFolderDirectChildCount(catalog, "root-a")).toBe(3);
    expect(getFolderDirectChildCount(catalog, "child-a")).toBe(2);
    expect(getFolderDirectChildCount(catalog, "grandchild")).toBe(1);
  });
});

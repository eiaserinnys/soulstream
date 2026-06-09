import { describe, expect, it } from "vitest";

import {
  buildFolderTreeOptions,
  compareFoldersByName,
  getFolderNameSortKey,
} from "./folder-tree-options";
import type { CatalogFolder } from "../shared/types";

function folder(
  id: string,
  name: string,
  parentFolderId: string | null = null,
  sortOrder = 0,
): CatalogFolder {
  return { id, name, parentFolderId, sortOrder };
}

describe("getFolderNameSortKey", () => {
  it("skips leading emoji clusters and following spaces", () => {
    expect(getFolderNameSortKey("📋 보드뷰")).toBe("보드뷰");
    expect(getFolderNameSortKey("👧🏻 서소영")).toBe("서소영");
    expect(getFolderNameSortKey("🗯️ 채널 개입")).toBe("채널 개입");
    expect(getFolderNameSortKey("👩‍💻 Development")).toBe("Development");
    expect(getFolderNameSortKey("📋🤖  Supervisors")).toBe("Supervisors");
  });

  it("keeps names that start with Korean, English, or digits unchanged", () => {
    expect(getFolderNameSortKey("보드뷰")).toBe("보드뷰");
    expect(getFolderNameSortKey("Dashboard")).toBe("Dashboard");
    expect(getFolderNameSortKey("123 Reports")).toBe("123 Reports");
  });
});

describe("buildFolderTreeOptions", () => {
  it("returns depth-first folder options sorted by emoji-skipped names within each level", () => {
    const result = buildFolderTreeOptions([
      folder("root-bravo", "📋 Bravo"),
      folder("child-beta", "🗯️ Beta", "root-alpha"),
      folder("grand-alpha", "🤖 Alpha grand", "child-alpha"),
      folder("root-alpha", "🤖 Alpha"),
      folder("child-alpha", "👧🏻 Alpha child", "root-alpha"),
    ]);

    expect(result.map((entry) => [entry.folder.id, entry.depth])).toEqual([
      ["root-alpha", 0],
      ["child-alpha", 1],
      ["grand-alpha", 2],
      ["child-beta", 1],
      ["root-bravo", 0],
    ]);
  });

  it("keeps folders with missing parents visible as root options", () => {
    const result = buildFolderTreeOptions([
      folder("root", "Root"),
      folder("orphan", "Orphan", "missing-parent"),
    ]);

    expect(result.map((entry) => [entry.folder.id, entry.depth])).toEqual([
      ["orphan", 0],
      ["root", 0],
    ]);
  });

  it("uses the original name as a deterministic tie-breaker", () => {
    const folders = [
      folder("emoji", "📋 Same"),
      folder("plain", "Same"),
      folder("alpha", "Alpha"),
    ];

    expect([...folders].sort(compareFoldersByName).map((entry) => entry.id)).toEqual([
      "alpha",
      "emoji",
      "plain",
    ]);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  deleteProjectFolder,
  renameProjectFolder,
  reorderProjectFolders,
} from "./project-folder-actions";

const folder = { id: "project-a", name: "Before", sortOrder: 0, parentFolderId: null };

describe("project folder optimistic result gate", () => {
  it("rejects a rename that the shared v1 operation rolled back", async () => {
    await expect(renameProjectFolder(folder, "After", vi.fn(async () => undefined), () => [folder]))
      .rejects.toThrow("이름 변경");
  });

  it("rejects a delete that the shared v1 operation rolled back", async () => {
    await expect(deleteProjectFolder(folder, vi.fn(async () => undefined), () => [folder]))
      .rejects.toThrow("삭제");
  });

  it("accepts only the optimistic hierarchy and order that remain applied", async () => {
    const items = [{ id: folder.id, parentFolderId: "project-b", sortOrder: 1 }];
    await expect(reorderProjectFolders(items, vi.fn(async () => undefined), () => [{
      ...folder,
      parentFolderId: "project-b",
      sortOrder: 1,
    }])).resolves.toBeUndefined();
    await expect(reorderProjectFolders(items, vi.fn(async () => undefined), () => [folder]))
      .rejects.toThrow("이동");
  });
});

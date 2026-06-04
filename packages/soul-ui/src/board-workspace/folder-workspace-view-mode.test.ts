import { describe, expect, it } from "vitest";

import {
  FOLDER_WORKSPACE_ROOT_STORAGE_ID,
  getFolderWorkspaceViewModeStorageKey,
  readFolderWorkspaceViewMode,
  writeFolderWorkspaceViewMode,
} from "./folder-workspace-view-mode";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class ThrowingStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new Error("blocked");
  }

  override setItem(): void {
    throw new Error("blocked");
  }
}

describe("folder workspace view mode storage", () => {
  it("uses the folder id as the storage key suffix and a root sentinel for null", () => {
    expect(getFolderWorkspaceViewModeStorageKey("folder-1")).toBe(
      "soulstream:folder-workspace:view-mode:v1:folder-1",
    );
    expect(getFolderWorkspaceViewModeStorageKey(null)).toBe(
      `soulstream:folder-workspace:view-mode:v1:${FOLDER_WORKSPACE_ROOT_STORAGE_ID}`,
    );
  });

  it("defaults to list when nothing is stored", () => {
    expect(readFolderWorkspaceViewMode(new MemoryStorage(), "folder-1")).toBe("list");
  });

  it("round-trips board mode per folder", () => {
    const storage = new MemoryStorage();

    writeFolderWorkspaceViewMode(storage, "folder-1", "board");

    expect(readFolderWorkspaceViewMode(storage, "folder-1")).toBe("board");
    expect(readFolderWorkspaceViewMode(storage, "folder-2")).toBe("list");
  });

  it("falls back to list when storage is unavailable or corrupted", () => {
    const storage = new MemoryStorage();
    storage.setItem(getFolderWorkspaceViewModeStorageKey("folder-1"), "grid");

    expect(readFolderWorkspaceViewMode(storage, "folder-1")).toBe("list");
    expect(readFolderWorkspaceViewMode(new ThrowingStorage(), "folder-1")).toBe("list");
    expect(() => writeFolderWorkspaceViewMode(new ThrowingStorage(), "folder-1", "board")).not.toThrow();
  });
});

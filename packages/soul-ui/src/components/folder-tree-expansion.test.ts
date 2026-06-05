import { describe, expect, it } from "vitest";

import {
  getFolderTreeExpandedStorageKey,
  readFolderTreeExpandedState,
  writeFolderTreeExpandedState,
} from "./folder-tree-expansion";

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

describe("folder tree expansion storage", () => {
  it("uses a stable per-folder key", () => {
    expect(getFolderTreeExpandedStorageKey("folder-1")).toBe(
      "soulstream:folder-tree:expanded:v1:folder-1",
    );
  });

  it("defaults to collapsed when no state is stored", () => {
    expect(readFolderTreeExpandedState(new MemoryStorage(), "folder-1")).toBe(false);
  });

  it("round-trips expanded state per folder", () => {
    const storage = new MemoryStorage();

    writeFolderTreeExpandedState(storage, "folder-1", true);

    expect(readFolderTreeExpandedState(storage, "folder-1")).toBe(true);
    expect(readFolderTreeExpandedState(storage, "folder-2")).toBe(false);
  });

  it("falls back to collapsed when storage is unavailable or corrupted", () => {
    const storage = new MemoryStorage();
    storage.setItem(getFolderTreeExpandedStorageKey("folder-1"), "wat");

    expect(readFolderTreeExpandedState(storage, "folder-1")).toBe(false);
    expect(readFolderTreeExpandedState(new ThrowingStorage(), "folder-1")).toBe(false);
    expect(() => writeFolderTreeExpandedState(new ThrowingStorage(), "folder-1", true)).not.toThrow();
  });
});

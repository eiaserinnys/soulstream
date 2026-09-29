import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FolderSnapshot, useFolderChecklistStore } from "./folder-checklist-store";

const originalFetch = globalThis.fetch;
const time = "2026-07-17T00:00:00Z";

function snapshot(name: string): FolderSnapshot {
  return {
    folder: {
      id: "folder-1", name, parentFolderId: null, projectPageId: "page-1",
      checklistEnabled: true, status: "open", archived: false, version: 1,
      createdSessionId: null, createdEventId: null, completedKind: null,
      completedSessionId: null, completedEventId: null, completedUserId: null,
      completedAt: null, createdAt: time, updatedAt: time,
    },
    sections: [], items: [],
  };
}

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

describe("folder checklist store", () => {
  beforeEach(() => { useFolderChecklistStore.getState().reset(); vi.restoreAllMocks(); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("loads the folder snapshot once and caches it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(snapshot("기획")));
    globalThis.fetch = fetchMock;
    const first = await useFolderChecklistStore.getState().loadFolder("folder-1");
    const second = await useFolderChecklistStore.getState().loadFolder("folder-1");
    expect(first?.folder.name).toBe("기획");
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/folders/folder-1");
  });

  it("posts checklist item status and reloads the folder snapshot", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ folderId: "folder-1", operation: "updated", idempotent: false }))
      .mockResolvedValueOnce(response(snapshot("수정됨")));
    globalThis.fetch = fetchMock;
    const result = await useFolderChecklistStore.getState().setItemStatus({
      folderId: "folder-1", itemId: "item-1", expectedVersion: 3,
      status: "completed", idempotencyKey: "item-status-1",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/folders/folder-1/checklist/items/item-1/status");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      status: "completed", expectedVersion: 3, idempotencyKey: "item-status-1",
    });
    expect(result?.folder.name).toBe("수정됨");
  });

  it("posts folder status and reloads the folder snapshot", async () => {
    const completed = snapshot("완료됨");
    completed.folder.status = "completed";
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ folderId: "folder-1" }))
      .mockResolvedValueOnce(response(completed));
    globalThis.fetch = fetchMock;
    const result = await useFolderChecklistStore.getState().setFolderStatus({
      folderId: "folder-1", expectedVersion: 1, status: "completed", idempotencyKey: "folder-status-1",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/folders/folder-1/status");
    expect(result?.folder.status).toBe("completed");
  });

  it("rolls back an optimistic checklist mutation after a failed request", async () => {
    const before = snapshot("기획");
    useFolderChecklistStore.setState({ byId: {
      "folder-1": { snapshot: before, status: "ready", error: null, isRefreshing: false },
    } });
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(useFolderChecklistStore.getState().mutateChecklist({
      kind: "create_section", folderId: "folder-1", sectionId: "section-1",
      title: "새 섹션", idempotencyKey: "create-section-1",
    })).rejects.toThrow("network down");
    expect(useFolderChecklistStore.getState().byId["folder-1"].snapshot).toBe(before);
  });

  it("refreshes an observed folder on folder_updated without loading an unseen folder", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(snapshot("이전")))
      .mockResolvedValueOnce(response(snapshot("이후")));
    globalThis.fetch = fetchMock;
    await useFolderChecklistStore.getState().loadFolder("folder-1");
    await useFolderChecklistStore.getState().handleFolderUpdated({ type: "folder_updated", folderId: "folder-1" });
    expect(useFolderChecklistStore.getState().byId["folder-1"].snapshot?.folder.name).toBe("이후");
    expect(useFolderChecklistStore.getState().handleFolderUpdated({ type: "folder_updated", folderId: "unseen" })).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

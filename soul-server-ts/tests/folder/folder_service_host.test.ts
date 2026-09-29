import { afterEach, describe, expect, it, vi } from "vitest";

import { FolderService } from "../../src/folder/folder_service.js";

const logger = { warn: vi.fn(), info: vi.fn() } as never;

afterEach(() => vi.unstubAllGlobals());

describe("FolderService host contract", () => {
  it("sends folder mutations to the single folder owner with snake_case fields", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({
        folder: { id: "folder-1" }, operation: { targetId: "folder-1" }, idempotent: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const service = new FolderService({
      orch: { baseUrl: "http://orch.local", headers: { authorization: "Bearer test" } },
      logger,
    });
    await service.createFolder({
      actorKind: "agent", actorSessionId: "session-1",
      parentFolderId: "parent-1",
      name: "Work", checklistEnabled: true,
      initialContext: { guidance: "Use the checklist", atomReferences: [] },
      idempotencyKey: "create-1",
    });
    expect(calls[0]?.url).toBe("http://orch.local/api/folders/host/create_folder");
    expect(calls[0]?.body).toMatchObject({
      actor_kind: "agent", actor_session_id: "session-1",
      parent_folder_id: "parent-1",
      checklist_enabled: true, idempotency_key: "create-1",
      initial_context: { guidance: "Use the checklist", atomReferences: [] },
    });
    expect(calls[0]?.body).not.toHaveProperty("folder_id");
  });

  it("routes checklist item status and reads through the same folder host", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ folderId: "folder-1", item: { id: "item-1" }, operation: { targetId: "item-1" }, idempotent: false }),
        { status: 200, headers: { "content-type": "application/json" } });
    }));
    const service = new FolderService({
      orch: { baseUrl: "http://orch.local", headers: {} }, logger,
    });
    await service.setChecklistItemStatus({
      actorSessionId: "session-1", folderId: "folder-1", itemId: "item-1",
      expectedVersion: 3, status: "completed", idempotencyKey: "status-1",
    });
    await service.getFolder("folder-1");
    expect(urls).toEqual([
      "http://orch.local/api/folders/host/set_checklist_item_status",
      "http://orch.local/api/folders/host/get_folder",
    ]);
  });
  it("flattens assignee and removes operation selector fields from host bodies", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ folderId: "folder-1", operation: { id: "op-1" }, idempotent: false }),
        { status: 200, headers: { "content-type": "application/json" } });
    }));
    const service = new FolderService({ orch: { baseUrl: "http://orch.local", headers: {} }, logger });
    await service.createChecklistItem({
      actorSessionId: "session-1", folderId: "folder-1", sectionId: "section-1", title: "Item",
      assignee: { kind: "human", userId: "user-1" }, idempotencyKey: "create-1",
    });
    await service.setFolderArchived({
      actorSessionId: "session-1", folderId: "folder-1", expectedVersion: 2,
      archived: true, idempotencyKey: "archive-1",
    });
    await service.updateChecklistItem({
      actorSessionId: "session-1", folderId: "folder-1", itemId: "item-1",
      expectedVersion: 2, archived: false, idempotencyKey: "restore-1",
    });

    expect(calls[0]).toMatchObject({ url: "http://orch.local/api/folders/host/create_checklist_item",
      body: { folder_id: "folder-1", section_id: "section-1", assignee_kind: "human", assignee_user_id: "user-1" } });
    expect(calls[0]?.body).not.toHaveProperty("assignee");
    expect(calls[1]?.url).toBe("http://orch.local/api/folders/host/archive_folder");
    expect(calls[1]?.body).not.toHaveProperty("archived");
    expect(calls[2]?.url).toBe("http://orch.local/api/folders/host/unarchive_checklist_item");
    expect(calls[2]?.body).not.toHaveProperty("archived");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { FolderService } from "../../src/work-task/task_service.js";

const logger = { warn: vi.fn(), info: vi.fn() } as never;

afterEach(() => vi.unstubAllGlobals());

describe("FolderService host contract", () => {
  it("sends folder mutations to the single folder owner with snake_case fields", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({
        snapshot: { folder: { id: "folder-1" }, sections: [], items: [] },
        operation: { target_id: "folder-1" }, eventId: 1,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const service = new FolderService({
      orch: { baseUrl: "http://orch.local", headers: { authorization: "Bearer test" } },
      logger,
    });
    await service.createFolder({
      actorKind: "agent", actorSessionId: "session-1",
      parentFolderId: "parent-1", folderId: "folder-1",
      name: "Work", checklistEnabled: true,
      initialContext: { userBlock: { keepCamelCase: true } },
      idempotencyKey: "create-1",
    });
    expect(calls[0]?.url).toBe("http://orch.local/api/folders/host/create_folder");
    expect(calls[0]?.body).toMatchObject({
      actor_kind: "agent", actor_session_id: "session-1",
      parent_folder_id: "parent-1", folder_id: "folder-1",
      checklist_enabled: true, idempotency_key: "create-1",
      initial_context: { userBlock: { keepCamelCase: true } },
    });
  });

  it("routes checklist item status and reads through the same folder host", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ snapshot: { folder: { id: "folder-1" }, sections: [], items: [] }, operation: { target_id: "item-1" } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }));
    const service = new FolderService({
      orch: { baseUrl: "http://orch.local", headers: {} }, logger,
    });
    await service.setChecklistItemStatus({
      actorSessionId: "session-1", folderId: "folder-1", itemId: "item-1",
      expectedVersion: 3, status: "completed",
    });
    await service.getFolder("folder-1");
    expect(urls).toEqual([
      "http://orch.local/api/folders/host/set_checklist_item_status",
      "http://orch.local/api/folders/host/get_folder",
    ]);
  });
});

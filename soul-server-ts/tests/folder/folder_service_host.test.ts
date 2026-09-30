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

  it("reads the card snapshot through the folder host", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ folder: { id: "folder-1" }, cards: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const service = new FolderService({ orch: { baseUrl: "http://orch.local", headers: {} }, logger });
    expect(await service.getFolder("folder-1", { cardId: "card-1" })).toMatchObject({ cards: [] });
    expect(fetchMock).toHaveBeenCalledWith("http://orch.local/api/folders/host/get_folder", expect.objectContaining({ body: JSON.stringify({ folder_id: "folder-1", card_id: "card-1" }) }));
  });
  it("removes the operation selector from folder host bodies", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ folderId: "folder-1", operation: { id: "op-1" }, idempotent: false }),
        { status: 200, headers: { "content-type": "application/json" } });
    }));
    const service = new FolderService({ orch: { baseUrl: "http://orch.local", headers: {} }, logger });
    await service.setFolderArchived({
      actorSessionId: "session-1", folderId: "folder-1", expectedVersion: 2,
      archived: true, idempotencyKey: "archive-1",
    });
    expect(calls[0]?.url).toBe("http://orch.local/api/folders/host/archive_folder");
    expect(calls[0]?.body).not.toHaveProperty("archived");
  });
});

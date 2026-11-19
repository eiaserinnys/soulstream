import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationCatalog } from "../src/conversation/conversation_catalog.js";
import { registerConversationRoutes } from "../src/conversation/conversation_routes.js";
import { ConversationService } from "../src/conversation/conversation_service.js";
import { SessionResourceAccessError } from "../src/session/session_resource_access.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

const binding = {
  account_id: "account-a",
  namespace: "ns",
  external_key: "key",
  session_id: "thread-1",
  active_session_id: null,
  selected_model: "preset-a",
  creation_request: null,
  phase: "complete",
  instruction_id: null,
  notices: [],
  archived: false,
  first_input_is_initial_instruction: false,
};

function createSql(listed: readonly unknown[]) {
  return (async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("conversation_executions")) return [];
    if (text.includes("conversation_bindings")) return listed;
    return [];
  }) as never;
}

function setup(initialFolderId: string | null = null) {
  let row: Record<string, unknown> = {
    session_id: "thread-1",
    folder_id: initialFolderId,
    display_name: "스레드",
    node_id: "node-a",
    agent_id: null,
    created_at: new Date("2026-11-19T00:00:00.000Z"),
    status: "completed",
    model_preset: "preset-a",
  };
  const catalog = new ConversationCatalog({
    defaultNodeId: "node-a",
    listNodes: () => [{ nodeId: "node-a", connected: true }],
    listKnownForNode: () => [{
      id: "preset-a", label: "Preset A", backend: "claude", available: true,
      reason: null, reason_label: null, resets_at: null,
      usage_warning: false, weekly_headroom: null,
    }],
    listAgentProfiles: async () => ({}),
  });
  const requireFolderAccess = vi.fn(async (input: { folderId: string | null }) => {
    if (input.folderId === "missing-folder") {
      throw new SessionResourceAccessError("SESSION_ACCESS_DENIED", "Folder access denied", 403);
    }
  });
  const moveSessionToFolder = vi.fn(async (_sessionId: string, folderId: string | null) => {
    row = { ...row, folder_id: folderId };
  });
  const service = new ConversationService({
    sql: createSql([binding]),
    access: {
      requireFolderAccess,
      requireSessionAccess: async () => undefined,
    } as never,
    catalog,
    persistent: {} as never,
    reads: async () => ({ getSession: async () => row as never }) as never,
    create: async () => ({}) as never,
    waitForCreatedSession: async () => true,
    moveSessionToFolder,
  });
  const app = Fastify({ logger: false });
  apps.push(app);
  registerConversationRoutes(app, { service, resolveAccount: async () => "account-a" });
  return { app, moveSessionToFolder, requireFolderAccess, row: () => row };
}

describe("conversation thread collection", () => {
  it("moves the thread session to the collection and carries it in the patch response", async () => {
    const { app, moveSessionToFolder, requireFolderAccess, row } = setup();
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/conversations/v1/threads/thread-1",
      payload: { collection: "folder-b" },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().thread.collection).toBe("folder-b");
    expect(moveSessionToFolder).toHaveBeenCalledTimes(1);
    expect(moveSessionToFolder).toHaveBeenCalledWith("thread-1", "folder-b");
    expect(requireFolderAccess).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: "folder-b" }),
    );
    expect(row().folder_id).toBe("folder-b");

    const single = await app.inject({ method: "GET", url: "/api/conversations/v1/threads/thread-1" });
    expect(single.statusCode).toBe(200);
    expect(single.json().thread.collection).toBe("folder-b");
  });

  it("carries the current collection in the list and single thread responses", async () => {
    const { app } = setup("folder-a");
    const single = await app.inject({ method: "GET", url: "/api/conversations/v1/threads/thread-1" });
    expect(single.json().thread.collection).toBe("folder-a");

    const list = await app.inject({ method: "GET", url: "/api/conversations/v1/threads?namespace=ns" });
    expect(list.statusCode).toBe(200);
    expect(list.json().refs).toContainEqual(
      expect.objectContaining({ id: "thread-1", collection: "folder-a" }),
    );
  });

  it("rejects a collection the session folder route would reject", async () => {
    const { app, moveSessionToFolder, row } = setup("folder-a");
    const response = await app.inject({
      method: "PATCH",
      url: "/api/conversations/v1/threads/thread-1",
      payload: { collection: "missing-folder" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "SESSION_ACCESS_DENIED", message: "Folder access denied" },
    });
    expect(moveSessionToFolder).not.toHaveBeenCalled();
    expect(row().folder_id).toBe("folder-a");
  });
});

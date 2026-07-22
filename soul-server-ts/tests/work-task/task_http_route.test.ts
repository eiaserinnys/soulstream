import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DASHBOARD_AUTH_COOKIE_NAME } from "../../src/collaboration/board_yjs_auth.js";
import { TaskVersionConflict } from "../../src/work-task/task_models.js";
import type { TaskService } from "../../src/work-task/task_service.js";
import type { ChecklistTaskAdapter } from "../../src/page/checklist_task_adapter.js";
import { buildServer, type ServerInstance } from "../../src/server.js";

function createSilentLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    child: () => createSilentLogger(),
  };
}

const openServers: ServerInstance[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()?.close();
  }
});

describe("task HTTP write route", () => {
  it("rejects every legacy mutation route with 410", async () => {
    const server = await createServer(fakeTaskService());

    const createResponse = await server.inject({
      method: "POST",
      url: "/api/runbooks",
      payload: { title: "legacy write" },
    });
    const nestedResponse = await server.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/items/item-1/status",
      payload: { status: "completed" },
    });

    expect(createResponse.statusCode).toBe(410);
    expect(nestedResponse.statusCode).toBe(410);
    expect(nestedResponse.json()).toMatchObject({
      detail: { error: { code: "RUNBOOK_MUTATION_REMOVED" } },
    });
  });

  it("creates a browser task with user attribution and no session provenance", async () => {
    const service = fakeTaskService();
    const taskIdentityHost = fakeTaskIdentityHost();
    const server = await createServer(service, undefined, taskIdentityHost);

    const response = await server.inject({
      method: "POST",
      url: "/api/tasks",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(signJwt({ sub: "operator@example.com" }, "jwt-secret"))}`,
      },
      payload: {
        task_id: "00000000-0000-4000-8000-0000000000ae",
        title: "Browser work",
        folder_id: "folder-1",
        initial_context: {
          guidance: "직접 지침",
          atom_references: [{
            instance: "atom",
            node_id: "node-soulstream",
            node_title: "soulstream",
            depth: 3,
            titles_only: false,
          }],
          session_defaults: {
            agent_id: "roselin_codex",
            node_id: "eiaserinnys",
          },
        },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(taskIdentityHost.create).toHaveBeenCalledWith({
      actorKind: "user",
      actorSessionId: null,
      actorUserId: "operator@example.com",
      taskId: "00000000-0000-4000-8000-0000000000ae",
      title: "Browser work",
      description: undefined,
      folderId: "folder-1",
      initialContext: {
        guidance: "직접 지침",
        atomReferences: [{
          instance: "atom",
          nodeId: "node-soulstream",
          nodeTitle: "soulstream",
          depth: 3,
          titlesOnly: false,
        }],
        sessionDefaults: {
          agentId: "roselin_codex",
          nodeId: "eiaserinnys",
        },
      },
      idempotencyKey: expect.stringMatching(/^create_task:operator@example\.com:/),
    });
  });

  it("authenticates dashboard cookies and writes task-level user attribution", async () => {
    const service = fakeTaskService();
    const server = await createServer(service);
    const token = signJwt(
      { sub: "operator@example.com", exp: Math.floor(Date.now() / 1000) + 60 },
      "jwt-secret",
    );

    const response = await server.inject({
      method: "POST",
      url: "/api/tasks/rb-1/status",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
      },
      payload: {
        status: "completed",
        expectedVersion: 1,
        idempotencyKey: "task:rb-1:status:completed:v1:test",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(service.setTaskStatus).toHaveBeenCalledWith({
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      taskId: "rb-1",
      expectedVersion: 1,
      status: "completed",
      reason: null,
      idempotencyKey: "task:rb-1:status:completed:v1:test",
    });
    expect(response.json()).toMatchObject({
      ok: true,
      taskId: "rb-1",
      idempotent: false,
    });
  });

  it("returns 409 when TaskService rejects a stale task-level version", async () => {
    const service = fakeTaskService();
    service.setTaskStatus.mockRejectedValueOnce(
      new TaskVersionConflict("task", "rb-1", 1, 2),
    );
    const server = await createServer(service);

    const response = await server.inject({
      method: "POST",
      url: "/api/tasks/rb-1/status",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(signJwt({ sub: "user-1" }, "jwt-secret"))}`,
      },
      payload: {
        status: "open",
        expectedVersion: 1,
        idempotencyKey: "task:rb-1:status:open:v1:test",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      detail: {
        error: {
          code: "TASK_VERSION_CONFLICT",
          details: {
            targetKind: "task",
            targetId: "rb-1",
            expectedVersion: 1,
            actualVersion: 2,
          },
        },
      },
    });
  });

  it("authenticates dashboard cookies and writes user attribution through TaskService", async () => {
    const service = fakeTaskService();
    const server = await createServer(service);
    const token = signJwt(
      { sub: "operator@example.com", exp: Math.floor(Date.now() / 1000) + 60 },
      "jwt-secret",
    );

    const response = await server.inject({
      method: "POST",
      url: "/api/tasks/rb-1/items/item-1/status",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
      },
      payload: {
        status: "completed",
        expectedVersion: 1,
        idempotencyKey: "task:rb-1:item:item-1:status:completed:v1:test",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(service.setItemStatus).toHaveBeenCalledWith({
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      itemId: "item-1",
      expectedVersion: 1,
      status: "completed",
      reason: null,
      idempotencyKey: "task:rb-1:item:item-1:status:completed:v1:test",
    });
    expect(response.json()).toMatchObject({
      ok: true,
      taskId: "rb-1",
      itemId: "item-1",
      idempotent: false,
    });
  });

  it("routes page-backed checklist completion through the production adapter", async () => {
    const service = fakeTaskService({
      taskId: "page-task:page-1",
      itemId: "checklist:block-1",
    });
    const setChecked = vi.fn(async () => ({
      projection: {
        properties: { taskId: "page-task:page-1", itemId: "checklist:block-1" },
        status: "completed" as const,
        checked: true,
      },
      mutation: {
        eventId: 12,
        idempotent: false,
        operation: {
          id: "op-1",
          operation_type: "set_item_status",
        },
        snapshot: await service.getTask("page-task:page-1"),
      },
    }));
    const server = await createServer(service, { setChecked });

    const response = await server.inject({
      method: "POST",
      url: "/api/tasks/page-task%3Apage-1/items/checklist%3Ablock-1/status",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(signJwt({ sub: "operator@example.com" }, "jwt-secret"))}`,
      },
      payload: {
        status: "completed",
        expectedVersion: 1,
        idempotencyKey: "checklist:block-1:complete",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(setChecked).toHaveBeenCalledWith({
      taskId: "page-task:page-1",
      itemId: "checklist:block-1",
      checked: true,
      expectedVersion: 1,
      actor: {
        actorKind: "user",
        actorSessionId: "sess-actor",
        actorUserId: "operator@example.com",
      },
      reason: null,
      idempotencyKey: "checklist:block-1:complete",
    });
    expect(service.setItemStatus).not.toHaveBeenCalled();
  });

  it("fails explicitly instead of bypassing a missing page checklist adapter", async () => {
    const service = fakeTaskService({
      taskId: "page-task:page-1",
      itemId: "checklist:block-1",
    });
    const server = await createServer(service);

    const response = await server.inject({
      method: "POST",
      url: "/api/tasks/page-task%3Apage-1/items/checklist%3Ablock-1/status",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(signJwt({ sub: "operator@example.com" }, "jwt-secret"))}`,
      },
      payload: {
        status: "completed",
        expectedVersion: 1,
        idempotencyKey: "checklist:block-1:missing-adapter",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(service.setItemStatus).not.toHaveBeenCalled();
  });

  it("accepts review as a dashboard item status mutation", async () => {
    const service = fakeTaskService();
    const server = await createServer(service);
    const token = signJwt(
      { sub: "operator@example.com", exp: Math.floor(Date.now() / 1000) + 60 },
      "jwt-secret",
    );

    const response = await server.inject({
      method: "POST",
      url: "/api/tasks/rb-1/items/item-1/status",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
      },
      payload: {
        status: "review",
        expectedVersion: 1,
        idempotencyKey: "task:rb-1:item:item-1:status:review:v1:test",
        reason: "ready for review",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(service.setItemStatus).toHaveBeenCalledWith({
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      itemId: "item-1",
      expectedVersion: 1,
      status: "review",
      reason: "ready for review",
      idempotencyKey: "task:rb-1:item:item-1:status:review:v1:test",
    });
  });

  it("returns 409 when TaskService rejects a stale version", async () => {
    const service = fakeTaskService();
    service.setItemStatus.mockRejectedValueOnce(
      new TaskVersionConflict("item", "item-1", 1, 2),
    );
    const server = await createServer(service);

    const response = await server.inject({
      method: "POST",
      url: "/api/tasks/rb-1/items/item-1/status",
      headers: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(signJwt({ sub: "user-1" }, "jwt-secret"))}`,
      },
      payload: {
        status: "pending",
        expectedVersion: 1,
        idempotencyKey: "task:rb-1:item:item-1:status:pending:v1:test",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      detail: {
        error: {
          code: "TASK_VERSION_CONFLICT",
          details: {
            targetKind: "item",
            targetId: "item-1",
            expectedVersion: 1,
            actualVersion: 2,
          },
        },
      },
    });
  });
});

async function createServer(
  service: ReturnType<typeof fakeTaskService>,
  checklistAdapter?: Pick<ChecklistTaskAdapter, "setChecked">,
  taskIdentityHost = fakeTaskIdentityHost(),
): Promise<ServerInstance> {
  const server = await buildServer({
    host: "127.0.0.1",
    port: 0,
    nodeId: "test-node",
    logger: createSilentLogger(),
    task: {
      service: service as unknown as TaskService,
      taskIdentityHost: taskIdentityHost as never,
      checklistAdapter,
      auth: {
        authBearerToken: "",
        environment: "production",
        dashboardAuthEnabled: true,
        jwtSecret: "jwt-secret",
      },
    },
  });
  openServers.push(server);
  return server;
}

function fakeTaskIdentityHost() {
  const id = "00000000-0000-4000-8000-0000000000ae";
  return {
    create: vi.fn(async () => ({
      id,
      pageId: id,
      taskId: id,
      operation: { id: "op-create" },
      pageOperation: { id: "op-page" },
      snapshot: { task: { id }, sections: [], items: [] },
    })),
  };
}

function fakeTaskService(options: { taskId?: string; itemId?: string } = {}) {
  const snapshot = {
    task: {
      id: options.taskId ?? "rb-1",
      board_item_id: `task:${options.taskId ?? "rb-1"}`,
      folder_id: "f1",
      title: "Launch",
      status: "open",
      archived: false,
      version: 1,
      created_session_id: "sess-actor",
      created_event_id: 1,
      completed_kind: null,
      completed_session_id: null,
      completed_event_id: null,
      completed_user_id: null,
      completed_at: null,
      created_at: "2026-06-16T00:00:00+00:00",
      updated_at: "2026-06-16T00:00:00+00:00",
    },
    sections: [],
    items: [
      {
        id: options.itemId ?? "item-1",
        section_id: "sec-1",
        position_key: "a",
        title: "Check",
        how_to: "",
        status: "pending",
        archived: false,
        version: 1,
      },
    ],
  };
  return {
    createTask: vi.fn(async () => ({
      eventId: 0,
      operation: { id: "op-create", operation_type: "create_task" },
      snapshot,
    })),
    getTask: vi.fn(async () => snapshot),
    setTaskStatus: vi.fn(async () => ({
      eventId: 11,
      idempotent: false,
      operation: {
        id: "op-task-status",
        operation_type: "set_task_status",
      },
      snapshot,
    })),
    setItemStatus: vi.fn(async () => ({
      eventId: 12,
      idempotent: false,
      operation: {
        id: "op-1",
        operation_type: "set_item_status",
      },
      snapshot,
    })),
  };
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${body}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

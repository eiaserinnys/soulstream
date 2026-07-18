import { describe, expect, it, vi } from "vitest";

import {
  TaskRouteError,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  taskRouteAuthRequirements,
  type TaskAccessProvider,
  type TaskMutationHttpClient,
  type TaskRouteProvider,
  type TaskRouteOptions,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const folders = [
  { id: "folder-a", parentFolderId: null, name: "Alpha" },
  { id: "folder-a-child", parentFolderId: "folder-a", name: "Child" },
  { id: "folder-b", parentFolderId: null, name: "Beta" },
];

function createTaskIdentityResult() {
  const id = "00000000-0000-4000-8000-0000000000ae";
  return {
    id,
    pageId: id,
    taskId: id,
    operation: { id: "task-operation" },
    pageOperation: { id: "page-operation" },
    pageCommit: {
      operation: {
        id: "page-operation",
        page_id: id,
        target_block_id: null,
        operation_type: "create_page",
        actor_kind: "agent" as const,
        actor_session_id: "session-a",
        actor_event_id: 1,
        actor_user_id: null,
        idempotency_key: "mcp:create:one:page",
        expected_version: 0,
        result_version: 1,
        payload_json: {},
        reason: null,
        created_at: new Date(),
      },
      pageCreatedAt: new Date(),
      pageUpdatedAt: new Date(),
      idempotent: false,
    },
    snapshot: { task: { id }, sections: [], items: [] },
  };
}

const overview = {
  my_turn_items: [
    { item_id: "item-a", folder_id: "folder-a-child", title: "Allowed" },
    { item_id: "item-b", folder_id: "folder-b", title: "Denied" },
    "ignored",
  ],
  tasks: [
    {
      task_id: "rb-a",
      folder_id: "folder-a",
      title: "Allowed group",
      items: [
        { item_id: "item-a", folder_id: "folder-a-child" },
        { item_id: "item-b", folder_id: "folder-b" },
      ],
    },
    {
      task_id: "rb-b",
      folder_id: "folder-b",
      title: "Denied group",
      items: [{ item_id: "item-b", folder_id: "folder-b" }],
    },
  ],
};

const snapshot = {
  task: {
    id: "rb/1",
    folder_id: "folder-a",
    title: "Task",
    created_session_id: "sess-created",
    completed_session_id: "sess-completed",
  },
  sections: [
    {
      id: "sec-1",
      created_session_id: "sess-section-created",
      updated_session_id: "sess-section-updated",
    },
  ],
  items: [
    {
      id: "item/1",
      section_id: "sec-1",
      assignee_session_id: "sess-assignee",
      updated_session_id: "sess-updated",
      created_session_id: "sess-item-created",
    },
  ],
};

const ownerNode = {
  nodeId: "owner-node",
  host: "localhost",
  port: 4105,
};

const fallbackNode = {
  nodeId: "fallback-node",
  host: "localhost",
  port: 4106,
};

type ProviderCall =
  | ["listFolders"]
  | ["access"]
  | ["user"]
  | ["overview", unknown]
  | ["snapshot", string]
  | ["findNode", string]
  | ["listNodes"];

function createHarness(overrides: Partial<TaskRouteProvider> = {}) {
  const calls: ProviderCall[] = [];
  const provider: TaskRouteProvider = {
    async listFolders() {
      calls.push(["listFolders"]);
      return folders;
    },
    async getTaskOverview(input) {
      calls.push(["overview", input]);
      return overview;
    },
    async getTaskSnapshot(taskId) {
      calls.push(["snapshot", taskId]);
      return taskId === "missing" ? null : snapshot;
    },
    async findSessionNode(actorSessionId) {
      calls.push(["findNode", actorSessionId]);
      return actorSessionId === "sess-missing" ? null : ownerNode;
    },
    listConnectedNodes() {
      calls.push(["listNodes"]);
      return [fallbackNode];
    },
    ...overrides,
  };
  return { calls, provider };
}

function createAccessProvider(
  access: { restricted: boolean; allowedFolderIds?: string[] },
  calls: ProviderCall[],
): TaskAccessProvider {
  return {
    async resolveAccess() {
      calls.push(["access"]);
      return access;
    },
  };
}

function createAppWithTasks(
  access: { restricted: boolean; allowedFolderIds?: string[] },
  overrides: Partial<TaskRouteProvider> = {},
  httpClient: TaskMutationHttpClient = vi.fn(async () => ({
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: { ok: true },
  })),
  taskIdentityService: NonNullable<TaskRouteOptions["taskIdentityService"]> = {
    create: vi.fn(async (input: { taskId?: string; title: string }) => {
      const id = input.taskId ?? "00000000-0000-4000-8000-0000000000ae";
      return {
        id,
        pageId: id,
        taskId: id,
        operation: { id: "task-operation" },
        pageOperation: { id: "page-operation" },
        pageCommit: {
          operation: {
            id: "page-operation",
            page_id: id,
            target_block_id: null,
            operation_type: "batch_operations",
            actor_kind: "user" as const,
            actor_session_id: null,
            actor_event_id: null,
            actor_user_id: "user@example.com",
            idempotency_key: "create-task-identity-route",
            expected_version: 0,
            result_version: 1,
            payload_json: {},
            reason: null,
            created_at: new Date(),
          },
          pageCreatedAt: new Date(),
          pageUpdatedAt: new Date(),
          idempotent: false,
        },
        snapshot: { task: { id, title: input.title }, sections: [], items: [] },
      };
    }),
    promoteExistingPage: vi.fn(),
    mutateFromTask: vi.fn(),
    backfillLegacyTask: vi.fn(),
  },
) {
  const harness = createHarness(overrides);
  const app = createApp({
    config,
    taskRoutes: {
      provider: harness.provider,
      accessProvider: createAccessProvider(access, harness.calls),
      httpClient,
      async resolveDashboardUserId() {
        harness.calls.push(["user"]);
        return "user@example.com";
      },
      taskIdentityService,
      authBearerToken: "service-token",
    },
  });
  return { app, calls: harness.calls, httpClient };
}

describe("task route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps task routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [method, url, payload] of [
      ["POST", "/api/tasks", { title: "Work", folder_id: "folder-a" }],
      ["GET", "/api/tasks/my-turn", undefined],
      ["POST", "/api/tasks/rb-1/items/item-1/status", { status: "review" }],
      ["POST", "/api/tasks/rb-1/status", { status: "completed" }],
      ["GET", "/api/tasks/rb-1", undefined],
    ] as const) {
      expect(await app.inject({ method, url, payload })).toMatchObject({
        statusCode: 404,
      });
    }

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 76-79", () => {
    expect(taskRouteAuthRequirements).toEqual({
      "POST /api/tasks": true,
      "GET /api/tasks/my-turn": true,
      "POST /api/tasks/:task_id/items/:item_id/status": true,
      "POST /api/tasks/:task_id/status": true,
      "POST /api/tasks/:task_id/sections": true,
      "POST /api/tasks/:task_id/sections/:section_id": true,
      "POST /api/tasks/:task_id/sections/:section_id/move": true,
      "POST /api/tasks/:task_id/sections/:section_id/archive": true,
      "POST /api/tasks/:task_id/sections/:section_id/items": true,
      "POST /api/tasks/:task_id/items/:item_id": true,
      "POST /api/tasks/:task_id/items/:item_id/move": true,
      "POST /api/tasks/:task_id/items/:item_id/archive": true,
      "GET /api/tasks/:task_id": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) =>
        [
          "get_task_my_turn",
          "proxy_task_item_status",
          "proxy_task_status",
          "get_task",
        ].includes(route.name),
      )
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [76, "GET", "/api/tasks/my-turn", true],
      [77, "POST", "/api/tasks/{task_id}/items/{item_id}/status", true],
      [78, "POST", "/api/tasks/{task_id}/status", true],
      [79, "GET", "/api/tasks/{task_id}", true],
    ]);
  });

  it("creates one task identity in orch after folder access", async () => {
    const taskIdentityService = {
      create: vi.fn(async (input: { title: string }) => ({
        id: "00000000-0000-4000-8000-0000000000ae",
        pageId: "00000000-0000-4000-8000-0000000000ae",
        taskId: "00000000-0000-4000-8000-0000000000ae",
        operation: { id: "task-operation" },
        pageOperation: { id: "page-operation" },
        pageCommit: {
          operation: {
            id: "page-operation",
            page_id: "00000000-0000-4000-8000-0000000000ae",
            target_block_id: null,
            operation_type: "batch_operations",
            actor_kind: "user" as const,
            actor_session_id: null,
            actor_event_id: null,
            actor_user_id: "user@example.com",
            idempotency_key: "create_task:user:browser:page",
            expected_version: 0,
            result_version: 1,
            payload_json: {},
            reason: null,
            created_at: new Date(),
          },
          pageCreatedAt: new Date(),
          pageUpdatedAt: new Date(),
          idempotent: false,
        },
        snapshot: {
          task: { id: "00000000-0000-4000-8000-0000000000ae", title: input.title },
          sections: [],
          items: [],
        },
      })),
      promoteExistingPage: vi.fn(),
      mutateFromTask: vi.fn(),
      backfillLegacyTask: vi.fn(),
    };
    const { app, calls } = createAppWithTasks(
      { restricted: true, allowedFolderIds: ["folder-a"] },
      {},
      undefined,
      taskIdentityService,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { cookie: "sid=test" },
      payload: {
        task_id: "00000000-0000-4000-8000-0000000000ae",
        title: "Browser work",
        description: "One object",
        folder_id: "folder-a-child",
        initial_context: {
          guidance: "검증 근거를 남긴다.",
          atom_references: [{
            instance: "atom",
            node_id: "node-soulstream",
            node_title: "soulstream",
            depth: 4,
            titles_only: true,
          }],
        },
        idempotency_key: "create_task:user:browser",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: "00000000-0000-4000-8000-0000000000ae",
      pageId: "00000000-0000-4000-8000-0000000000ae",
      taskId: "00000000-0000-4000-8000-0000000000ae",
    });
    expect(calls).toEqual([["listFolders"], ["access"], ["user"]]);
    expect(taskIdentityService.create).toHaveBeenCalledWith({
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      description: "One object",
      folderId: "folder-a-child",
      initialContext: {
        guidance: "검증 근거를 남긴다.",
        atomReferences: [{
          instance: "atom",
          nodeId: "node-soulstream",
          nodeTitle: "soulstream",
          depth: 4,
          titlesOnly: true,
        }],
      },
      idempotencyKey: "create_task:user:browser",
      taskId: "00000000-0000-4000-8000-0000000000ae",
      title: "Browser work",
    });

    await app.close();
  });

  it("accepts a service-authenticated MCP creation through the same identity service", async () => {
    const taskIdentityService = {
      create: vi.fn(async () => createTaskIdentityResult()),
      promoteExistingPage: vi.fn(),
      mutateFromTask: vi.fn(),
      backfillLegacyTask: vi.fn(),
    };
    const { app } = createAppWithTasks(
      { restricted: false },
      {},
      undefined,
      taskIdentityService,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/task-identities/host/create",
      headers: { authorization: "Bearer service-token" },
      payload: {
        title: "MCP 업무",
        folder_id: "folder-a",
        initial_context: {
          guidance: "host 경로",
          atom_references: [],
        },
        actor_kind: "agent",
        actor_session_id: "session-a",
        idempotency_key: "mcp:create:one",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "00000000-0000-4000-8000-0000000000ae",
      pageId: "00000000-0000-4000-8000-0000000000ae",
      taskId: "00000000-0000-4000-8000-0000000000ae",
    });
    expect(taskIdentityService.create).toHaveBeenCalledWith({
      title: "MCP 업무",
      description: undefined,
      folderId: "folder-a",
      initialContext: {
        guidance: "host 경로",
        atomReferences: [],
      },
      taskId: undefined,
      x: undefined,
      y: undefined,
      actor: { actorKind: "agent", actorSessionId: "session-a", actorUserId: undefined },
      idempotencyKey: "mcp:create:one",
    });
    await app.close();
  });

  it("keeps my-turn ahead of the dynamic task id route", async () => {
    const { app, calls } = createAppWithTasks({ restricted: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/my-turn",
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      ["listFolders"],
      ["user"],
      ["overview", { userId: "user@example.com", limit: 100 }],
      ["access"],
    ]);
    expect(calls).not.toContainEqual(["snapshot", "my-turn"]);

    await app.close();
  });

  it("filters my-turn overview by descendant folder access", async () => {
    const { app } = createAppWithTasks({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/my-turn?limit=25",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      my_turn_items: [{ item_id: "item-a", folder_id: "folder-a-child", title: "Allowed" }],
      tasks: [
        {
          task_id: "rb-a",
          folder_id: "folder-a",
          title: "Allowed group",
          items: [{ item_id: "item-a", folder_id: "folder-a-child" }],
        },
      ],
    });

    await app.close();
  });

  it("maps missing task storage provider to 503", async () => {
    const { app } = createAppWithTasks(
      { restricted: false },
      { getTaskOverview: undefined },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/my-turn",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ detail: "Task storage is not configured" });

    await app.close();
  });

  it("returns task snapshots after access check", async () => {
    const { app, calls } = createAppWithTasks({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/rb%2F1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot);
    expect(calls).toEqual([
      ["snapshot", "rb/1"],
      ["listFolders"],
      ["access"],
    ]);

    await app.close();
  });

  it("keeps production-gated legacy HTTP reads and rejects every legacy write", async () => {
    const { app } = createAppWithTasks({ restricted: false });

    const overviewResponse = await app.inject({
      method: "GET",
      url: "/api/runbooks/my-turn?limit=25",
    });
    const snapshotResponse = await app.inject({
      method: "GET",
      url: "/api/runbooks/rb%2F1",
    });
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/runbooks",
      payload: { title: "legacy write" },
    });
    const mutationResponse = await app.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/items/item-1/status",
      payload: { status: "completed" },
    });

    expect(overviewResponse.statusCode).toBe(200);
    expect(overviewResponse.json()).toHaveProperty("runbooks");
    expect(overviewResponse.json()).not.toHaveProperty("tasks");
    expect(snapshotResponse.statusCode).toBe(200);
    expect(snapshotResponse.json()).toHaveProperty("runbook.id", "rb/1");
    expect(snapshotResponse.json()).not.toHaveProperty("task");
    expect(createResponse.statusCode).toBe(410);
    expect(mutationResponse.statusCode).toBe(410);

    await app.close();
  });

  it("proxies item status mutations to the actor session node with auth headers", async () => {
    const httpClient: TaskMutationHttpClient = vi.fn(async () => ({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
    }));
    const { app, calls } = createAppWithTasks(
      { restricted: true, allowedFolderIds: ["folder-a"] },
      {},
      httpClient,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/rb%2F1/items/item%2F1/status",
      headers: {
        authorization: "Bearer test-token",
        cookie: "sid=test",
        "x-extra": "not-forwarded",
      },
      payload: {
        status: "review",
        expected_version: 7,
        idempotency_key: "idem-1",
        reason: "ready",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      ["snapshot", "rb/1"],
      ["listFolders"],
      ["access"],
      ["findNode", "sess-assignee"],
    ]);
    expect(httpClient).toHaveBeenCalledWith({
      method: "POST",
      url: "http://localhost:4105/api/tasks/rb%2F1/items/item%2F1/status",
      upstreamPath: "/api/tasks/rb%2F1/items/item%2F1/status",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
      body: {
        status: "review",
        expectedVersion: 7,
        idempotencyKey: "idem-1",
        reason: "ready",
      },
      target: ownerNode,
    });

    await app.close();
  });

  it("falls back to the first connected node when actor session is not routable", async () => {
    const fallbackSnapshot = {
      ...snapshot,
      task: { ...snapshot.task, created_session_id: "sess-missing" },
      items: [{ id: "item-1" }],
    };
    const { app, calls, httpClient } = createAppWithTasks(
      { restricted: false },
      { async getTaskSnapshot() {
        return fallbackSnapshot;
      } },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/rb-1/items/item-1/status",
      payload: { status: "completed", expectedVersion: 1, idempotencyKey: "idem" },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toContainEqual(["findNode", "sess-missing"]);
    expect(calls).toContainEqual(["listNodes"]);
    expect(httpClient).toHaveBeenCalledWith(expect.objectContaining({
      target: fallbackNode,
    }));

    await app.close();
  });

  it("rejects missing item, missing provenance, and invalid status before proxying", async () => {
    const httpClient: TaskMutationHttpClient = vi.fn();
    const { app } = createAppWithTasks(
      { restricted: false },
      { async getTaskSnapshot() {
        return {
          task: { id: "rb-1", folder_id: "folder-a" },
          sections: [],
          items: [{ id: "item-1" }],
        };
      } },
      httpClient,
    );

    const missingItem = await app.inject({
      method: "POST",
      url: "/api/tasks/rb-1/items/missing/status",
      payload: { status: "review", expectedVersion: 1, idempotencyKey: "idem" },
    });
    const missingProvenance = await app.inject({
      method: "POST",
      url: "/api/tasks/rb-1/items/item-1/status",
      payload: { status: "review", expectedVersion: 1, idempotencyKey: "idem" },
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/api/tasks/rb-1/items/item-1/status",
      payload: { status: "open", expectedVersion: 1, idempotencyKey: "idem" },
    });

    expect(missingItem.statusCode).toBe(404);
    expect(missingItem.json()).toEqual({ detail: "Task item not found" });
    expect(missingProvenance.statusCode).toBe(422);
    expect(missingProvenance.json()).toEqual({
      detail: "Task item has no session provenance",
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({
      detail: "status must be one of: pending, review, completed, cancelled",
    });
    expect(httpClient).not.toHaveBeenCalled();

    await app.close();
  });

  it("proxies task status mutations and preserves non-JSON upstream responses", async () => {
    const httpClient: TaskMutationHttpClient = vi.fn(async () => ({
      statusCode: 409,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "conflict",
    }));
    const { app } = createAppWithTasks(
      { restricted: false },
      {},
      httpClient,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/rb%2F1/status",
      payload: {
        status: "completed",
        expectedVersion: 3,
        idempotencyKey: "idem-task",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.body).toBe("conflict");
    expect(httpClient).toHaveBeenCalledWith(expect.objectContaining({
      upstreamPath: "/api/tasks/rb%2F1/status",
      body: {
        status: "completed",
        expectedVersion: 3,
        idempotencyKey: "idem-task",
      },
      target: ownerNode,
    }));

    await app.close();
  });

  it("proxies authenticated section and item CRUD through the canonical owner node", async () => {
    const httpClient: TaskMutationHttpClient = vi.fn(async () => ({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true, snapshot },
    }));
    const { app, calls } = createAppWithTasks(
      { restricted: false },
      {},
      httpClient,
    );

    const requests = [
      {
        url: "/api/tasks/rb%2F1/sections",
        payload: {
          sectionId: "sec-new",
          title: "New section",
          idempotencyKey: "create-section",
        },
        upstreamPath: "/api/tasks/rb%2F1/sections",
        actorSessionId: "sess-completed",
      },
      {
        url: "/api/tasks/rb%2F1/sections/sec-1/move",
        payload: {
          expectedVersion: 2,
          beforeSectionId: "sec-0",
          idempotencyKey: "move-section",
        },
        upstreamPath: "/api/tasks/rb%2F1/sections/sec-1/move",
        actorSessionId: "sess-section-updated",
      },
      {
        url: "/api/tasks/rb%2F1/items/item%2F1",
        payload: {
          title: "Updated item",
          howTo: "Steps",
          expectedVersion: 3,
          idempotencyKey: "update-item",
        },
        upstreamPath: "/api/tasks/rb%2F1/items/item%2F1",
        actorSessionId: "sess-assignee",
      },
    ];

    for (const request of requests) {
      const response = await app.inject({
        method: "POST",
        url: request.url,
        headers: {
          cookie: "dashboard_auth=jwt",
          authorization: "Bearer dashboard",
        },
        payload: request.payload,
      });
      expect(response.statusCode).toBe(200);
      expect(httpClient).toHaveBeenLastCalledWith(expect.objectContaining({
        upstreamPath: request.upstreamPath,
        body: request.payload,
        headers: {
          cookie: "dashboard_auth=jwt",
          authorization: "Bearer dashboard",
        },
        target: ownerNode,
      }));
      expect(calls).toContainEqual(["findNode", request.actorSessionId]);
    }

    await app.close();
  });

  it("rejects CRUD for inaccessible or missing targets before contacting a worker", async () => {
    const httpClient: TaskMutationHttpClient = vi.fn(async () => ({
      statusCode: 200,
      body: { ok: true },
    }));
    const { app: deniedApp } = createAppWithTasks(
      { restricted: true, allowedFolderIds: ["folder-b"] },
      {},
      httpClient,
    );
    const { app: missingApp } = createAppWithTasks(
      { restricted: false },
      {},
      httpClient,
    );

    const denied = await deniedApp.inject({
      method: "POST",
      url: "/api/tasks/rb%2F1/sections",
      payload: { title: "Denied", idempotencyKey: "denied" },
    });
    const missing = await missingApp.inject({
      method: "POST",
      url: "/api/tasks/rb%2F1/items/missing/archive",
      payload: { expectedVersion: 1, idempotencyKey: "missing" },
    });
    const invalid = await missingApp.inject({
      method: "POST",
      url: "/api/tasks/rb%2F1/items/item%2F1",
      payload: { title: 7, expectedVersion: 3, idempotencyKey: "update-item" },
    });

    expect(denied.statusCode).toBe(403);
    expect(missing.statusCode).toBe(404);
    expect(invalid.statusCode).toBe(400);
    expect(httpClient).not.toHaveBeenCalled();

    await deniedApp.close();
    await missingApp.close();
  });

  it("preserves non-fallback resolver errors and maps request failures to 502", async () => {
    const httpClient: TaskMutationHttpClient = vi.fn(async () => {
      throw new Error("network down");
    });
    const resolverError = new TaskRouteError(
      "NODE_RESOLVER_FAILED",
      "resolver failed",
      409,
    );
    const { app: resolverApp } = createAppWithTasks(
      { restricted: false },
      { async findSessionNode() {
        throw resolverError;
      } },
    );
    const { app: requestApp } = createAppWithTasks(
      { restricted: false },
      {},
      httpClient,
    );

    const resolverResponse = await resolverApp.inject({
      method: "POST",
      url: "/api/tasks/rb-1/status",
      payload: { status: "completed", expectedVersion: 1, idempotencyKey: "idem" },
    });
    const requestResponse = await requestApp.inject({
      method: "POST",
      url: "/api/tasks/rb-1/status",
      payload: { status: "completed", expectedVersion: 1, idempotencyKey: "idem" },
    });

    expect(resolverResponse.statusCode).toBe(409);
    expect(resolverResponse.json()).toEqual({ detail: "resolver failed" });
    expect(requestResponse.statusCode).toBe(502);
    expect(requestResponse.body).toBe("");

    await resolverApp.close();
    await requestApp.close();
  });
});

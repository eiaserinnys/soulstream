import { describe, expect, it, vi } from "vitest";

import {
  InMemorySseReplayBroadcaster,
  TaskMutationRouteError,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  taskMutationRouteAuthRequirements,
  type TaskMutationResponse,
  type TaskMutationRouteProvider,
  type TaskReadRouteProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const mutationResult: TaskMutationResponse = {
  task: {
    id: "task-1",
    status: "in_progress",
    title: "Task one",
  },
  operation: {
    id: "operation-1",
    taskId: "task-1",
    operationType: "update_task_item",
    actorEventId: 101,
  },
  eventId: 101,
};

function createMutationProvider(
  overrides: Partial<TaskMutationRouteProvider> = {},
): TaskMutationRouteProvider {
  return {
    createTask: vi.fn(async () => mutationResult),
    setTaskStatus: vi.fn(async () => mutationResult),
    updateTask: vi.fn(async () => mutationResult),
    moveTask: vi.fn(async () => mutationResult),
    linkTask: vi.fn(async () => mutationResult),
    holdTask: vi.fn(async () => mutationResult),
    archiveTask: vi.fn(async () => mutationResult),
    pinTask: vi.fn(async () => mutationResult),
    listTaskOperations: vi.fn(async () => [
      {
        id: "operation-1",
        taskId: "task-1",
        operationType: "set_task_status",
        actorEventId: 101,
      },
    ]),
    ...overrides,
  };
}

function createReadProvider(): TaskReadRouteProvider {
  return {
    listTasks: vi.fn(async () => []),
    getTaskContext: vi.fn(async () => ({
      activeTask: null,
      activeTaskPath: [],
      linkedTasks: [],
    })),
  };
}

describe("Task mutation route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps Task mutation routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [method, url, payload] of [
      ["POST", "/api/tasks", { sessionId: "sess-a", title: "Task" }],
      ["POST", "/api/tasks/task-1/status", { sessionId: "sess-a", status: "agent_done" }],
      ["PATCH", "/api/tasks/task-1", { sessionId: "sess-a", title: "Renamed" }],
      ["POST", "/api/tasks/task-1/move", { sessionId: "sess-a" }],
      [
        "POST",
        "/api/tasks/task-1/link",
        { sessionId: "sess-a", linkedSessionId: "linked-session" },
      ],
      ["POST", "/api/tasks/task-1/hold", { sessionId: "sess-a" }],
      ["POST", "/api/tasks/task-1/archive", { sessionId: "sess-a" }],
      ["POST", "/api/tasks/task-1/pin", { sessionId: "sess-a", pinned: true }],
      ["GET", "/api/tasks/task-1/operations", undefined],
      ["POST", "/api/execute", { prompt: "do not port route 110" }],
    ] as const) {
      expect(await app.inject({ method, url, payload })).toMatchObject({
        statusCode: 404,
      });
    }

    await app.close();
  });

  it("registers Python Task mutation auth contract rows for route inventory order 101-109", () => {
    expect(taskMutationRouteAuthRequirements).toEqual({
      "POST /api/tasks": true,
      "POST /api/tasks/:task_id/status": true,
      "PATCH /api/tasks/:task_id": true,
      "POST /api/tasks/:task_id/move": true,
      "POST /api/tasks/:task_id/link": true,
      "POST /api/tasks/:task_id/hold": true,
      "POST /api/tasks/:task_id/archive": true,
      "POST /api/tasks/:task_id/pin": true,
      "GET /api/tasks/:task_id/operations": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) => route.order >= 101 && route.order <= 110)
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [101, "POST", "/api/tasks", true],
      [102, "POST", "/api/tasks/{task_id}/status", true],
      [103, "PATCH", "/api/tasks/{task_id}", true],
      [104, "POST", "/api/tasks/{task_id}/move", true],
      [105, "POST", "/api/tasks/{task_id}/link", true],
      [106, "POST", "/api/tasks/{task_id}/hold", true],
      [107, "POST", "/api/tasks/{task_id}/archive", true],
      [108, "POST", "/api/tasks/{task_id}/pin", true],
      [109, "GET", "/api/tasks/{task_id}/operations", true],
      [110, "POST", "/api/execute", true],
    ]);
    expect(Object.keys(taskMutationRouteAuthRequirements)).not.toContain("POST /api/execute");
  });

  it("keeps the create signature but returns the v1 deprecation alternative", async () => {
    const provider = createMutationProvider();
    const app = createApp({
      config,
      taskMutationRoutes: { provider },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        sessionId: "parent-session",
        title: "New task",
        parentTaskId: "parent-task",
        idempotencyKey: "idem-create",
        linkedSessionId: "linked-session",
        linkedNodeId: "node-linked",
        navigationSessionId: "nav-session",
        navigationNodeId: "node-nav",
        navigationEventId: 77,
      },
    });
    const executeResponse = await app.inject({
      method: "POST",
      url: "/api/execute",
      payload: { prompt: "still hidden" },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({
      detail: expect.stringContaining(
        "업무는 create_runbook으로 생성하세요 — folder_id 지정이 필수입니다",
      ),
    });
    expect(executeResponse.statusCode).toBe(404);
    expect(provider.createTask).not.toHaveBeenCalled();

    await app.close();
  });

  it("passes status, update, move, and link payloads to the provider", async () => {
    const provider = createMutationProvider();
    const app = createApp({
      config,
      taskMutationRoutes: { provider },
    });

    await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/status",
      payload: {
        sessionId: "parent-session",
        status: "agent_done",
        reason: "done",
        expectedVersion: 3,
        idempotencyKey: "idem-status",
      },
    });
    await app.inject({
      method: "PATCH",
      url: "/api/tasks/task-1",
      payload: {
        sessionId: "parent-session",
        title: "  Renamed task  ",
        description: "New description",
        acceptanceCriteria: "New criteria",
        reason: "rename",
        expectedVersion: 4,
        idempotencyKey: "idem-update",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/move",
      payload: {
        sessionId: "parent-session",
        newParentTaskId: "new-parent",
        positionKey: 2.5,
        reason: "move",
        expectedVersion: 5,
        idempotencyKey: "idem-move",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/link",
      payload: {
        sessionId: "parent-session",
        linkedSessionId: "linked-session",
        linkedNodeId: "node-linked",
        navigationEventId: 99,
        reason: "link",
        expectedVersion: 6,
      },
    });

    expect(provider.setTaskStatus).toHaveBeenCalledWith("task-1", {
      sessionId: "parent-session",
      status: "agent_done",
      reason: "done",
      expectedVersion: 3,
      idempotencyKey: "idem-status",
    });
    expect(provider.updateTask).toHaveBeenCalledWith("task-1", {
      sessionId: "parent-session",
      title: "Renamed task",
      description: "New description",
      acceptanceCriteria: "New criteria",
      reason: "rename",
      expectedVersion: 4,
      idempotencyKey: "idem-update",
    });
    expect(provider.moveTask).toHaveBeenCalledWith("task-1", {
      sessionId: "parent-session",
      newParentTaskId: "new-parent",
      positionKey: 2.5,
      reason: "move",
      expectedVersion: 5,
      idempotencyKey: "idem-move",
    });
    expect(provider.linkTask).toHaveBeenCalledWith("task-1", {
      sessionId: "parent-session",
      linkedSessionId: "linked-session",
      linkedNodeId: "node-linked",
      navigationEventId: 99,
      useOperationAnchor: false,
      reason: "link",
      expectedVersion: 6,
    });

    await app.close();
  });

  it("passes hold, archive, and pin payloads with route-specific idempotency support", async () => {
    const provider = createMutationProvider();
    const app = createApp({
      config,
      taskMutationRoutes: { provider },
    });

    await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/hold",
      payload: {
        sessionId: "parent-session",
        reason: "blocked",
        expectedVersion: 7,
        idempotencyKey: "idem-hold",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/archive",
      payload: {
        sessionId: "parent-session",
        reason: "archive",
        expectedVersion: 8,
        idempotencyKey: "ignored-by-python-model",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/pin",
      payload: {
        sessionId: "parent-session",
        pinned: true,
        reason: "pin",
        expectedVersion: 9,
        idempotencyKey: "idem-pin",
      },
    });

    expect(provider.holdTask).toHaveBeenCalledWith("task-1", {
      sessionId: "parent-session",
      reason: "blocked",
      expectedVersion: 7,
      idempotencyKey: "idem-hold",
    });
    expect(provider.archiveTask).toHaveBeenCalledWith("task-1", {
      sessionId: "parent-session",
      reason: "archive",
      expectedVersion: 8,
    });
    expect(provider.pinTask).toHaveBeenCalledWith("task-1", {
      sessionId: "parent-session",
      pinned: true,
      reason: "pin",
      expectedVersion: 9,
      idempotencyKey: "idem-pin",
    });

    await app.close();
  });

  it("validates update editable fields and pin required boolean", async () => {
    const provider = createMutationProvider();
    const app = createApp({
      config,
      taskMutationRoutes: { provider },
    });

    const emptyTitle = await app.inject({
      method: "PATCH",
      url: "/api/tasks/task-1",
      payload: { sessionId: "parent-session", title: "  " },
    });
    const noFields = await app.inject({
      method: "PATCH",
      url: "/api/tasks/task-1",
      payload: { sessionId: "parent-session", reason: "only reason" },
    });
    const missingPinned = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/pin",
      payload: { sessionId: "parent-session" },
    });

    expect(emptyTitle.statusCode).toBe(422);
    expect(emptyTitle.json()).toEqual({ detail: "title must not be empty" });
    expect(noFields.statusCode).toBe(422);
    expect(noFields.json()).toEqual({ detail: "no task fields to update" });
    expect(missingPinned.statusCode).toBe(422);
    expect(missingPinned.json()).toEqual({ detail: "pinned must be a boolean" });
    expect(provider.updateTask).not.toHaveBeenCalled();
    expect(provider.pinTask).not.toHaveBeenCalled();

    await app.close();
  });

  it("uses Python operations limit defaults and range validation", async () => {
    const provider = createMutationProvider();
    const app = createApp({
      config,
      taskMutationRoutes: { provider },
    });

    const defaultResponse = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1/operations",
    });
    const maxResponse = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1/operations?limit=200",
    });
    const invalidResponse = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1/operations?limit=201",
    });

    expect(defaultResponse.statusCode).toBe(200);
    expect(defaultResponse.json()).toEqual({
      operations: [
        {
          id: "operation-1",
          taskId: "task-1",
          operationType: "set_task_status",
          actorEventId: 101,
        },
      ],
    });
    expect(maxResponse.statusCode).toBe(200);
    expect(invalidResponse.statusCode).toBe(422);
    expect(invalidResponse.json()).toEqual({ detail: "limit must be between 1 and 200" });
    expect(provider.listTaskOperations).toHaveBeenNthCalledWith(1, "task-1", {
      limit: 50,
    });
    expect(provider.listTaskOperations).toHaveBeenNthCalledWith(2, "task-1", {
      limit: 200,
    });

    await app.close();
  });

  it("maps explicit route errors to the {detail} envelope", async () => {
    const provider = createMutationProvider({
      setTaskStatus: vi.fn(async () => {
        throw new TaskMutationRouteError(
          409,
          "task item not found or version mismatch",
        );
      }),
    });
    const app = createApp({
      config,
      taskMutationRoutes: { provider },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/status",
      payload: { sessionId: "parent-session", status: "agent_done" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      detail: "task item not found or version mismatch",
    });

    await app.close();
  });

  it("does not let dynamic task routes capture task context or stream routes", async () => {
    const provider = createMutationProvider();
    const app = createApp({
      config,
      taskReadRoutes: { provider: createReadProvider() },
      sseReplayRoutes: {
        session: {
          broadcaster: new InMemorySseReplayBroadcaster({ instanceId: "instance-a" }),
          loadSnapshot: async () => ({ sessions: [] }),
        },
        task: {
          broadcaster: new InMemorySseReplayBroadcaster({ instanceId: "instance-a" }),
          loadSnapshot: async () => ({ tasks: [{ id: "task-snapshot" }] }),
        },
        replayOnlyForTests: true,
      },
      taskMutationRoutes: { provider },
    });

    const contextResponse = await app.inject({
      method: "GET",
      url: "/api/tasks/context?sessionId=sess-a",
    });
    const streamResponse = await app.inject({ method: "GET", url: "/api/tasks/stream" });
    const operationsResponse = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1/operations",
    });

    expect(contextResponse.statusCode).toBe(200);
    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.body).toContain("event: task_list");
    expect(operationsResponse.statusCode).toBe(200);
    expect(provider.listTaskOperations).toHaveBeenCalledTimes(1);

    await app.close();
  });
});

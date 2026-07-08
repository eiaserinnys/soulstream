import { describe, expect, it, vi } from "vitest";

import {
  InMemorySseReplayBroadcaster,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  taskReadRouteAuthRequirements,
  type SerializedTaskItem,
  type TaskReadContext,
  type TaskReadRouteProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

function createProvider(overrides: Partial<TaskReadRouteProvider> = {}): TaskReadRouteProvider {
  const serializedTask: SerializedTaskItem = {
    id: "task-1",
    parentId: null,
    positionKey: 1,
    title: "Task one",
    description: "Read-only task",
    acceptanceCriteria: "",
    verificationOwner: "agent",
    status: "in_progress",
    linkedSessionId: "linked-session",
    linkedNodeId: "node-a",
    activeForSessionId: "sess-a",
    createdFromSessionId: "sess-a",
    createdFromEventId: 10,
    navigationSessionId: "linked-session",
    navigationNodeId: "node-a",
    navigationEventId: 20,
    archived: false,
    pinned: false,
    version: 2,
    createdAt: "2026-07-08T00:00:00+00:00",
    updatedAt: "2026-07-08T00:01:00+00:00",
    linkedSession: {
      agentSessionId: "linked-session",
      nodeId: "node-a",
    },
  };
  return {
    listTasks: vi.fn(async () => [serializedTask]),
    getTaskContext: vi.fn(async () => ({
      activeTask: null,
      activeTaskPath: [],
      linkedTasks: [],
    })),
    ...overrides,
  };
}

describe("Task read-only route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps Task read routes disabled on the default app", async () => {
    const app = createApp({ config });

    expect(await app.inject({ method: "GET", url: "/api/tasks" })).toMatchObject({
      statusCode: 404,
    });
    expect(await app.inject({ method: "GET", url: "/api/tasks/context?sessionId=sess-a" }))
      .toMatchObject({ statusCode: 404 });
    expect(await app.inject({ method: "GET", url: "/api/tasks/stream" })).toMatchObject({
      statusCode: 404,
    });

    await app.close();
  });

  it("registers only Python Task read auth contract rows for route inventory order 98-100", () => {
    expect(taskReadRouteAuthRequirements).toEqual({
      "GET /api/tasks": true,
      "GET /api/tasks/context": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) => route.order >= 98 && route.order <= 101)
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [98, "GET", "/api/tasks", true],
      [99, "GET", "/api/tasks/stream", true],
      [100, "GET", "/api/tasks/context", true],
      [101, "POST", "/api/tasks", true],
    ]);
    expect(Object.keys(taskReadRouteAuthRequirements)).not.toContain("GET /api/tasks/stream");
    expect(Object.keys(taskReadRouteAuthRequirements)).not.toContain("POST /api/tasks");
  });

  it("passes normalized list query parameters to the provider and preserves serialized tasks", async () => {
    const provider = createProvider();
    const app = createApp({
      config,
      taskReadRoutes: { provider },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks?query=roadmap&status=in_progress&rootTaskId=root-1&linkedSessionId=sess-linked&includeArchived=true&limit=12",
    });
    const streamResponse = await app.inject({ method: "GET", url: "/api/tasks/stream" });
    const mutationResponse = await app.inject({ method: "POST", url: "/api/tasks" });

    expect(response.statusCode).toBe(200);
    expect(streamResponse.statusCode).toBe(404);
    expect(mutationResponse.statusCode).toBe(404);
    expect(provider.listTasks).toHaveBeenCalledWith({
      query: "roadmap",
      status: "in_progress",
      rootTaskId: "root-1",
      linkedSessionId: "sess-linked",
      includeArchived: true,
      limit: 12,
    });
    expect(response.json()).toEqual({
      tasks: [
        expect.objectContaining({
          id: "task-1",
          parentId: null,
          positionKey: 1,
          acceptanceCriteria: "",
          verificationOwner: "agent",
          linkedSessionId: "linked-session",
          linkedSession: {
            agentSessionId: "linked-session",
            nodeId: "node-a",
          },
        }),
      ],
    });

    await app.close();
  });

  it("uses Python list defaults and validates status and limit range", async () => {
    const provider = createProvider({ listTasks: vi.fn(async () => []) });
    const app = createApp({
      config,
      taskReadRoutes: { provider },
    });

    const defaultResponse = await app.inject({ method: "GET", url: "/api/tasks" });
    const badStatus = await app.inject({ method: "GET", url: "/api/tasks?status=done" });
    const badLimit = await app.inject({ method: "GET", url: "/api/tasks?limit=1001" });
    const badIncludeArchived = await app.inject({
      method: "GET",
      url: "/api/tasks?includeArchived=maybe",
    });

    expect(defaultResponse.statusCode).toBe(200);
    expect(provider.listTasks).toHaveBeenCalledWith({
      query: undefined,
      status: undefined,
      rootTaskId: undefined,
      linkedSessionId: undefined,
      includeArchived: false,
      limit: 500,
    });
    expect(badStatus.statusCode).toBe(422);
    expect(badStatus.json()).toEqual({ detail: "Invalid task status" });
    expect(badLimit.statusCode).toBe(422);
    expect(badLimit.json()).toEqual({ detail: "limit must be between 1 and 1000" });
    expect(badIncludeArchived.statusCode).toBe(422);
    expect(badIncludeArchived.json()).toEqual({ detail: "includeArchived must be a boolean" });

    await app.close();
  });

  it("requires sessionId for task context and preserves provider-owned context shape", async () => {
    const provider = createProvider({
      getTaskContext: vi.fn(async (sessionId: string): Promise<TaskReadContext> => ({
        activeTask: {
          id: "active-task",
          status: "open",
          linkedSession: null,
        },
        activeTaskPath: [{ id: "root-task", status: "open", linkedSession: null }],
        linkedTasks: [{ id: "linked-task", status: "agent_done", linkedSession: null }],
        sessionId,
      })),
    });
    const app = createApp({
      config,
      taskReadRoutes: { provider },
    });

    const missing = await app.inject({ method: "GET", url: "/api/tasks/context" });
    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/context?sessionId=sess-a",
    });

    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toEqual({ detail: "sessionId query parameter is required" });
    expect(response.statusCode).toBe(200);
    expect(provider.getTaskContext).toHaveBeenCalledWith("sess-a");
    expect(response.json()).toEqual({
      activeTask: {
        id: "active-task",
        status: "open",
        linkedSession: null,
      },
      activeTaskPath: [{ id: "root-task", status: "open", linkedSession: null }],
      linkedTasks: [{ id: "linked-task", status: "agent_done", linkedSession: null }],
      sessionId: "sess-a",
    });

    await app.close();
  });

  it("coexists with SSE replay task stream without duplicate route registration", async () => {
    const app = createApp({
      config,
      taskReadRoutes: { provider: createProvider({ listTasks: vi.fn(async () => []) }) },
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
    });

    const listResponse = await app.inject({ method: "GET", url: "/api/tasks" });
    const contextResponse = await app.inject({
      method: "GET",
      url: "/api/tasks/context?sessionId=sess-a",
    });
    const streamResponse = await app.inject({ method: "GET", url: "/api/tasks/stream" });

    expect(listResponse.statusCode).toBe(200);
    expect(contextResponse.statusCode).toBe(200);
    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.body).toContain("event: task_list");

    await app.close();
  });
});

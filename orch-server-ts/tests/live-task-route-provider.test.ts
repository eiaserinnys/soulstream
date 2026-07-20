import { describe, expect, it, vi } from "vitest";

import {
  InMemorySseReplayBroadcaster,
  LiveNodeHttpClientError,
  createApp,
  createLiveTaskRouteProviders,
  createLiveTaskMutationHttpClient,
  parseOrchServerConfig,
  type TaskAccessProvider,
  type TaskRouteProvider,
  type SessionStreamEvent,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const targetNode = {
  nodeId: "task-node",
  host: "ignored-host",
  port: 4105,
};

describe("live task route provider", () => {
  it("forwards explicit task mutation fields through the live node HTTP boundary", async () => {
    const requestNode = vi.fn(async () => ({
      statusCode: 202,
      headers: { "content-type": "application/json" },
      body: { accepted: true },
    }));
    const httpClient = createLiveTaskMutationHttpClient({
      nodeHttpClient: { requestNode },
    });
    const body = {
      status: "completed",
      expectedVersion: 7,
      idempotencyKey: "idem-task",
      reason: "done",
    };

    const response = await httpClient({
      method: "POST",
      url: "http://python-proxy.invalid/this/path/must/not/be/used",
      upstreamPath: "/api/tasks/rb%2F1/status",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
      body,
      target: targetNode,
    });

    expect(response).toEqual({
      statusCode: 202,
      headers: { "content-type": "application/json" },
      body: { accepted: true },
    });
    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "task-node",
      method: "POST",
      path: "/api/tasks/rb%2F1/status",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
      body,
    });
  });

  it("passes non-2xx non-JSON upstream responses through without throwing", async () => {
    const requestNode = vi.fn(async () => ({
      statusCode: 409,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "conflict",
    }));
    const httpClient = createLiveTaskMutationHttpClient({
      nodeHttpClient: { requestNode },
    });

    await expect(
      httpClient({
        method: "POST",
        url: "http://ignored.example.test/api/tasks/rb-1/status",
        upstreamPath: "/api/tasks/rb-1/status",
        headers: {},
        body: { status: "completed", expectedVersion: 1, idempotencyKey: "idem" },
        target: targetNode,
      }),
    ).resolves.toEqual({
      statusCode: 409,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "conflict",
    });
  });

  it.each([
    [
      "stale node",
      new LiveNodeHttpClientError("NODE_HTTP_TARGET_STALE", "stale node", {
        nodeId: "task-node",
      }),
    ],
    ["request failure", new Error("request failed")],
  ])("maps %s errors to the existing task route 502 catch", async (_label, error) => {
    const requestNode = vi.fn(async () => {
      throw error;
    });
    const app = createTaskApp(
      createLiveTaskMutationHttpClient({ nodeHttpClient: { requestNode } }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/rb-1/status",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
      payload: {
        status: "completed",
        expectedVersion: 1,
        idempotencyKey: "idem",
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.body).toBe("");
    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "task-node",
      method: "POST",
      path: "/api/tasks/rb-1/status",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
      body: {
        status: "completed",
        expectedVersion: 1,
        idempotencyKey: "idem",
      },
    });

    await app.close();
  });

  it("broadcasts one canonical task_updated event for a new user mutation", async () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId: "task-user-status",
    });
    const setTaskStatusAsUser = vi.fn(async () => ({
      ok: true as const,
      taskId: "task-1",
      boardItemId: "task:task-1",
      eventId: 0 as const,
      idempotent: false,
      operation: { id: "operation-1" },
      snapshot: { task: { id: "task-1" } },
    }));
    const provider: TaskRouteProvider = {
      listFolders: () => [],
      setTaskStatusAsUser,
    };
    const bundle = createLiveTaskRouteProviders({
      provider,
      broadcaster,
      nodeHttpClient: { requestNode: vi.fn() },
    });

    await bundle.taskRoutes.provider.setTaskStatusAsUser?.({
      taskId: "task-1",
      status: "completed",
      expectedVersion: 1,
      idempotencyKey: "task-user-status",
      userId: "user@example.com",
    });

    expect(broadcaster.bufferedEvents.map((event) => event.payload)).toEqual([{
      type: "task_updated",
      taskId: "task-1",
      boardItemId: "task:task-1",
    }]);
  });

  it("does not rebroadcast an idempotent user mutation", async () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>();
    const provider: TaskRouteProvider = {
      listFolders: () => [],
      async setTaskStatusAsUser() {
        return {
          ok: true,
          taskId: "task-1",
          boardItemId: "task:task-1",
          eventId: 0,
          idempotent: true,
          operation: { id: "operation-1" },
          snapshot: { task: { id: "task-1" } },
        };
      },
    };
    const bundle = createLiveTaskRouteProviders({
      provider,
      broadcaster,
      nodeHttpClient: { requestNode: vi.fn() },
    });

    await bundle.taskRoutes.provider.setTaskStatusAsUser?.({
      taskId: "task-1",
      status: "completed",
      expectedVersion: 1,
      idempotencyKey: "task-user-status",
      userId: "user@example.com",
    });

    expect(broadcaster.bufferedEvents).toEqual([]);
  });
});

function createTaskApp(httpClient: ReturnType<typeof createLiveTaskMutationHttpClient>) {
  const provider: TaskRouteProvider = {
    async listFolders() {
      return [{ id: "folder-a", parentFolderId: null, name: "Alpha" }];
    },
    async getTaskSnapshot() {
      return {
        task: {
          id: "rb-1",
          folder_id: "folder-a",
          created_session_id: "sess-created",
        },
        sections: [],
        items: [],
      };
    },
    async findSessionNode() {
      return targetNode;
    },
    listConnectedNodes() {
      return [targetNode];
    },
  };
  const accessProvider: TaskAccessProvider = {
    async resolveAccess() {
      return { restricted: false };
    },
  };
  return createApp({
    config,
    taskRoutes: {
      provider,
      accessProvider,
      httpClient,
    },
  });
}

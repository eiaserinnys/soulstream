import { describe, expect, it } from "vitest";

import {
  InMemorySseReplayBroadcaster,
  buildTaskChangedStreamEvent,
  createApp,
  loadContractFixtures,
  registerSseReplayRoutes,
  sseReplayRouteAuthRequirements,
  type SessionStreamEvent,
  type TaskStreamChange,
  type TaskStreamEvent,
} from "../src/index.js";

describe("SSE replay HTTP route harness", () => {
  const fixtures = loadContractFixtures();
  const fixture = fixtures.sseReplayGap;
  const instanceId = "current-instance-id";
  const config = {
    environment: "test" as const,
    databaseUrl: "postgresql://test/test",
    authBearerToken: "test-token",
  };

  function createSessionBroadcaster(options: { ringMaxlen?: number } = {}) {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId,
      ringMaxlen: options.ringMaxlen,
    });
    for (const event of fixture.sessionStream.events) {
      broadcaster.append(event as SessionStreamEvent);
    }
    return broadcaster;
  }

  function createTaskBroadcaster() {
    const broadcaster = new InMemorySseReplayBroadcaster<TaskStreamEvent>({
      instanceId,
    });
    for (const change of fixture.taskStream.changes) {
      broadcaster.append(buildTaskChangedStreamEvent(change as TaskStreamChange));
    }
    return broadcaster;
  }

  function createHarness(options: { ringMaxlen?: number } = {}) {
    const sessions = [{ agent_session_id: "sess-snapshot", title: "Snapshot" }];
    const tasks = [{ id: "task-snapshot", status: "open" }];
    return {
      session: {
        broadcaster: createSessionBroadcaster(options),
        loadSnapshot: async () => ({ sessions, total: sessions.length }),
      },
      task: {
        broadcaster: createTaskBroadcaster(),
        loadSnapshot: async () => ({ tasks, total: tasks.length }),
      },
      replayOnlyForTests: true,
    };
  }

  it("keeps SSE replay routes disabled on the default app", async () => {
    const app = createApp({ config });

    expect(await app.inject({ method: "GET", url: "/api/sessions/stream" })).toMatchObject({
      statusCode: 404,
    });
    expect(await app.inject({ method: "GET", url: "/api/tasks/stream" })).toMatchObject({
      statusCode: 404,
    });
  });

  it("registers only the two auth-required SSE replay routes when explicitly enabled", async () => {
    const app = createApp({
      config,
      sseReplayRoutes: createHarness(),
    });

    expect(sseReplayRouteAuthRequirements).toEqual({
      "GET /api/sessions/stream": true,
      "GET /api/tasks/stream": true,
    });
    expect(
      fixtures.routeInventory.routes
        .filter((route) => route.name === "session_stream" || route.name === "task_stream")
        .map((route) => [route.methods[0], route.path, route.authRequired]),
    ).toEqual([
      ["GET", "/api/sessions/stream", true],
      ["GET", "/api/tasks/stream", true],
    ]);
    expect(await app.inject({ method: "GET", url: "/api/nodes/stream" })).toMatchObject({
      statusCode: 404,
    });
  });

  it("sends stream metadata and injectable snapshots on first connection without SSE ids", async () => {
    const app = createApp({
      config,
      sseReplayRoutes: createHarness(),
    });

    const sessionResponse = await app.inject({
      method: "GET",
      url: "/api/sessions/stream",
    });
    const taskResponse = await app.inject({
      method: "GET",
      url: "/api/tasks/stream",
    });

    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.headers["content-type"]).toContain("text/event-stream");
    expect(sessionResponse.body).toBe(
      'event: stream_meta\n' +
        'data: {"type":"stream_meta","instance_id":"current-instance-id","latest_id":3}\n\n' +
        'event: session_list\n' +
        'data: {"type":"session_list","sessions":[{"agent_session_id":"sess-snapshot","title":"Snapshot"}],"total":1}\n\n',
    );
    expect(sessionResponse.body).not.toContain("id:");

    expect(taskResponse.statusCode).toBe(200);
    expect(taskResponse.body).toBe(
      'event: stream_meta\n' +
        'data: {"type":"stream_meta","instance_id":"current-instance-id","latest_id":3}\n\n' +
        'event: task_list\n' +
        'data: {"type":"task_list","tasks":[{"id":"task-snapshot","status":"open"}],"total":1}\n\n',
    );
    expect(taskResponse.body).not.toContain("id:");
  });

  it("prefers Last-Event-ID header over lastEventId query and formats replay events with SSE ids", async () => {
    const app = createApp({
      config,
      sseReplayRoutes: createHarness(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/stream?lastEventId=0&instanceId=current-instance-id",
      headers: {
        "Last-Event-ID": "1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      'event: stream_meta\n' +
        'data: {"type":"stream_meta","instance_id":"current-instance-id","latest_id":3}\n\n' +
        "event: session_updated\n" +
        "id: 2\n" +
        'data: {"type":"session_updated","agent_session_id":"sess-1"}\n\n' +
        "event: session_deleted\n" +
        "id: 3\n" +
        'data: {"type":"session_deleted","agent_session_id":"sess-1"}\n\n',
    );
  });

  it("streams task replay events using the common task_changed event shape", async () => {
    const app = createApp({
      config,
      sseReplayRoutes: createHarness(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/stream?lastEventId=1&instanceId=current-instance-id",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      'event: stream_meta\n' +
        'data: {"type":"stream_meta","instance_id":"current-instance-id","latest_id":3}\n\n' +
        "event: task_changed\n" +
        "id: 2\n" +
        'data: {"type":"task_changed","change":{"id":"task-1","status":"in_progress"}}\n\n' +
        "event: task_changed\n" +
        "id: 3\n" +
        'data: {"type":"task_changed","change":{"id":"task-1","status":"review"}}\n\n',
    );
  });

  it("maps ring gap and instance mismatch to replay_gap without SSE id", async () => {
    const app = createApp({
      config,
      sseReplayRoutes: createHarness({ ringMaxlen: fixture.gap.ringMaxlen }),
    });

    const ringGap = await app.inject({
      method: "GET",
      url: "/api/sessions/stream?lastEventId=0&instanceId=current-instance-id",
    });
    const instanceMismatch = await app.inject({
      method: "GET",
      url: "/api/sessions/stream?lastEventId=1&instanceId=stale-instance",
    });

    expect(ringGap.statusCode).toBe(200);
    expect(ringGap.body).toBe(
      'event: stream_meta\n' +
        'data: {"type":"stream_meta","instance_id":"current-instance-id","latest_id":3}\n\n' +
        "event: replay_gap\n" +
        'data: {"type":"replay_gap","latest_id":3,"instance_id":"current-instance-id","reason":"ring_gap"}\n\n',
    );
    expect(ringGap.body).not.toContain("id:");

    expect(instanceMismatch.statusCode).toBe(200);
    expect(instanceMismatch.body).toBe(
      'event: stream_meta\n' +
        'data: {"type":"stream_meta","instance_id":"current-instance-id","latest_id":3}\n\n' +
        "event: replay_gap\n" +
        'data: {"type":"replay_gap","latest_id":3,"instance_id":"current-instance-id","reason":"instance_mismatch"}\n\n',
    );
    expect(instanceMismatch.body).not.toContain("id:");
  });

  it("returns 400 for invalid Last-Event-ID header or lastEventId query", async () => {
    const app = createApp({
      config,
      sseReplayRoutes: createHarness(),
    });

    const invalidHeader = await app.inject({
      method: "GET",
      url: "/api/sessions/stream?lastEventId=1&instanceId=current-instance-id",
      headers: {
        "Last-Event-ID": "not-an-integer",
      },
    });
    const invalidQuery = await app.inject({
      method: "GET",
      url: "/api/tasks/stream?lastEventId=-1&instanceId=current-instance-id",
    });

    expect(invalidHeader.statusCode).toBe(400);
    expect(invalidHeader.json()).toMatchObject({
      error: { code: "INVALID_SSE_CURSOR" },
    });
    expect(invalidQuery.statusCode).toBe(400);
    expect(invalidQuery.json()).toMatchObject({
      error: { code: "INVALID_SSE_CURSOR" },
    });
  });

  it("can be registered directly on a Fastify instance for route-boundary tests", async () => {
    const app = createApp({ config });

    registerSseReplayRoutes(app, createHarness());

    expect(await app.inject({ method: "GET", url: "/api/sessions/stream" })).toMatchObject({
      statusCode: 200,
    });
  });
});

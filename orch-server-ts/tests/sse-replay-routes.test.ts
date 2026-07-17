import type { FastifyRequest } from "fastify";
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

  function parseSseEvents(body: string) {
    return body
      .trim()
      .split("\n\n")
      .map((chunk) => {
        const lines = chunk.split("\n");
        const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
        const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
        const dataLine = lines.find((line) => line.startsWith("data: "));
        return {
          event,
          id,
          data: dataLine === undefined ? undefined : JSON.parse(dataLine.slice(6)),
        };
      });
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

  it("passes the session stream request to the snapshot loader", async () => {
    const observedFeedOnly: string[] = [];
    const app = createApp({
      config,
      sseReplayRoutes: {
        ...createHarness(),
        session: {
          broadcaster: createSessionBroadcaster(),
          loadSnapshot: async (request: FastifyRequest) => {
            observedFeedOnly.push(String((request.query as Record<string, unknown>).feed_only));
            return { sessions: [], total: 0 };
          },
        },
      },
    });

    await app.inject({
      method: "GET",
      url: "/api/sessions/stream?feed_only=true",
    });

    expect(observedFeedOnly).toEqual(["true"]);
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

  it("replays page_updated as a named additive session event with its SSE id", async () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({ instanceId });
    broadcaster.append({ type: "page_updated", page_id: "page-1", version: 7 });
    const app = createApp({
      config,
      sseReplayRoutes: {
        ...createHarness(),
        session: {
          broadcaster,
          loadSnapshot: async () => ({ sessions: [], total: 0 }),
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/stream?lastEventId=0&instanceId=current-instance-id",
    });

    expect(parseSseEvents(response.body)).toEqual([
      {
        event: "stream_meta",
        id: undefined,
        data: { type: "stream_meta", instance_id: instanceId, latest_id: 1 },
      },
      {
        event: "page_updated",
        id: "1",
        data: { type: "page_updated", page_id: "page-1", version: 7 },
      },
    ]);
  });

  it("filters session replay events request-aware while preserving emitted SSE ids", async () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
      instanceId,
    });
    broadcaster.append({
      type: "session_created",
      agent_session_id: "hidden-session",
      folderId: "hidden",
    });
    broadcaster.append({
      type: "session_created",
      agent_session_id: "visible-session",
      folderId: "visible",
    });
    const app = createApp({
      config,
      sseReplayRoutes: {
        ...createHarness(),
        session: {
          broadcaster,
          loadSnapshot: async () => ({ sessions: [], total: 0 }),
          filterEvent: async (request, event) => {
            const query = request.query as Record<string, unknown>;
            if (query.feed_only === "true" && event.folderId === "hidden") {
              return null;
            }
            return event;
          },
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/stream?lastEventId=0&instanceId=current-instance-id&feed_only=true",
    });

    expect(response.statusCode).toBe(200);
    expect(parseSseEvents(response.body)).toEqual([
      {
        event: "stream_meta",
        id: undefined,
        data: {
          type: "stream_meta",
          instance_id: "current-instance-id",
          latest_id: 2,
        },
      },
      {
        event: "session_created",
        id: "2",
        data: {
          type: "session_created",
          agent_session_id: "visible-session",
          folderId: "visible",
        },
      },
    ]);
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

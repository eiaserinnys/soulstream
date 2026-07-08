import { describe, expect, it } from "vitest";

import {
  PendingNodeCommandTimeoutError,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  registerSessionBackgroundScheduleRoutes,
  sessionBackgroundScheduleRouteAuthRequirements,
} from "../src/index.js";
import { createBackgroundScheduleHarness } from "./session-background-schedule-test-helpers.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("session background task/schedule route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps background task and schedule routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [method, url, payload] of [
      ["GET", "/api/sessions/sess-contract/background-tasks", undefined],
      ["GET", "/api/sessions/sess-contract/background-tasks/bg-1/output", undefined],
      ["POST", "/api/sessions/sess-contract/background-tasks/bg-1/stop", undefined],
      [
        "POST",
        "/api/sessions/sess-contract/background-tasks/background",
        { toolUseId: "toolu-bash" },
      ],
      ["GET", "/api/sessions/sess-contract/schedules", undefined],
      ["DELETE", "/api/sessions/sess-contract/schedules/sched-1", undefined],
    ] as const) {
      expect(
        await app.inject({
          method,
          url,
          payload,
        }),
      ).toMatchObject({ statusCode: 404 });
    }

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 16-21", async () => {
    expect(sessionBackgroundScheduleRouteAuthRequirements).toEqual({
      "GET /api/sessions/:session_id/background-tasks": true,
      "GET /api/sessions/:session_id/background-tasks/:task_id/output": true,
      "POST /api/sessions/:session_id/background-tasks/:task_id/stop": true,
      "POST /api/sessions/:session_id/background-tasks/background": true,
      "GET /api/sessions/:session_id/schedules": true,
      "DELETE /api/sessions/:session_id/schedules/:schedule_id": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) =>
        [
          "list_background_tasks",
          "get_background_task_output",
          "stop_background_task",
          "background_tasks",
          "list_schedules",
          "delete_schedule",
        ].includes(route.name),
      )
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [16, "GET", "/api/sessions/{session_id}/background-tasks", true],
      [17, "GET", "/api/sessions/{session_id}/background-tasks/{task_id}/output", true],
      [18, "POST", "/api/sessions/{session_id}/background-tasks/{task_id}/stop", true],
      [19, "POST", "/api/sessions/{session_id}/background-tasks/background", true],
      [20, "GET", "/api/sessions/{session_id}/schedules", true],
      [21, "DELETE", "/api/sessions/{session_id}/schedules/{schedule_id}", true],
    ]);
  });

  it("sends background task list/output/stop node commands", async () => {
    const { app, sent } = createBackgroundScheduleHarness();

    const list = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-contract/background-tasks",
    });
    const output = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-contract/background-tasks/bg-1/output",
    });
    const stop = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/background-tasks/bg-1/stop",
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ tasks: [{ taskId: "bg-1" }] });
    expect(output.statusCode).toBe(200);
    expect(output.json()).toMatchObject({ taskId: "bg-1", output: "done" });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toMatchObject({ taskId: "bg-1", stopped: true });
    expect(sent).toEqual([
      expect.objectContaining({
        type: "claude_runtime_list_tasks",
        agentSessionId: "sess-contract",
      }),
      expect.objectContaining({
        type: "claude_runtime_task_output",
        agentSessionId: "sess-contract",
        taskId: "bg-1",
      }),
      expect.objectContaining({
        type: "claude_runtime_stop_task",
        agentSessionId: "sess-contract",
        taskId: "bg-1",
      }),
    ]);

    await app.close();
  });

  it("accepts optional background body aliases and prevents command envelope override", async () => {
    const { app, sent } = createBackgroundScheduleHarness();

    const emptyBody = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/background-tasks/background",
    });
    const aliasedBody = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/background-tasks/background",
      payload: {
        type: "claude_runtime_stop_task",
        requestId: "malicious-command-id",
        fireAndForget: true,
        tool_use_id: "toolu-bash",
      },
    });

    expect(emptyBody.statusCode).toBe(200);
    expect(aliasedBody.statusCode).toBe(200);
    expect(sent[0]).toEqual({
      type: "claude_runtime_background_tasks",
      requestId: "background-claude_runtime_background_tasks-2-1700000000000",
      agentSessionId: "sess-contract",
    });
    expect(sent[1]).toEqual({
      type: "claude_runtime_background_tasks",
      requestId: "background-claude_runtime_background_tasks-3-1700000000000",
      agentSessionId: "sess-contract",
      toolUseId: "toolu-bash",
    });

    await app.close();
  });

  it("keeps background static route from being consumed as a task id route", async () => {
    const { app, sent } = createBackgroundScheduleHarness();

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/background-tasks/background",
      payload: { toolUseId: "toolu-static" },
    });

    expect(response.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "claude_runtime_background_tasks",
      toolUseId: "toolu-static",
    });
    expect(sent[0]).not.toMatchObject({
      taskId: "background",
    });

    await app.close();
  });

  it("sends schedule list/delete commands and preserves non-error delete statuses", async () => {
    const { app, sent } = createBackgroundScheduleHarness({
      ackFor: (message) =>
        message.type === "claude_runtime_delete_schedule"
          ? {
              type: "claude_runtime_delete_schedule_ack",
              status: "not_found",
              deleted: false,
              scheduleId: message.scheduleId,
            }
          : {},
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-contract/schedules",
    });
    const deleteResponse = await app.inject({
      method: "DELETE",
      url: "/api/sessions/sess-contract/schedules/sched-1",
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ schedules: [{ scheduleId: "sched-1" }] });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({
      status: "not_found",
      deleted: false,
      scheduleId: "sched-1",
    });
    expect(sent).toEqual([
      expect.objectContaining({
        type: "claude_runtime_list_schedules",
        agentSessionId: "sess-contract",
      }),
      expect.objectContaining({
        type: "claude_runtime_delete_schedule",
        agentSessionId: "sess-contract",
        scheduleId: "sched-1",
      }),
    ]);

    await app.close();
  });

  it("maps delete schedule already_firing ACK to 409 while preserving the ACK body", async () => {
    const { app } = createBackgroundScheduleHarness({
      ackFor: (message) => ({
        type: "claude_runtime_delete_schedule_ack",
        status: "already_firing",
        deleted: false,
        sessionId: message.agentSessionId,
        scheduleId: message.scheduleId,
      }),
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/sessions/sess-contract/schedules/sched-1",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      type: "claude_runtime_delete_schedule_ack",
      status: "already_firing",
      deleted: false,
      sessionId: "sess-contract",
      scheduleId: "sched-1",
    });

    await app.close();
  });

  it("maps runtime status error ACKs and dispatch error wire to Python-compatible statuses", async () => {
    for (const [code, message, statusCode] of [
      ["TASK_NOT_FOUND", "task not found", 404],
      ["CLAUDE_RUNTIME_NOT_SUPPORTED", "background task support missing", 422],
      ["CLAUDE_RUNTIME_FAILED", "runtime failed", 422],
    ] as const) {
      const { app } = createBackgroundScheduleHarness({
        ackFor: () => ({
          type: "claude_runtime_task_output_ack",
          status: "error",
          code,
          message,
        }),
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/sessions/sess-contract/background-tasks/bg-1/output",
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({
        error: { code, message },
      });
      await app.close();
    }

    const dispatchError = createBackgroundScheduleHarness({
      ackFor: () => ({
        type: "error",
        code: "TASK_NOT_FOUND",
        message: "task not found from dispatch",
      }),
    });
    const dispatchResponse = await dispatchError.app.inject({
      method: "GET",
      url: "/api/sessions/sess-contract/background-tasks/bg-1/output",
    });
    expect(dispatchResponse.statusCode).toBe(404);
    expect(dispatchResponse.json()).toMatchObject({
      error: { code: "TASK_NOT_FOUND", message: "task not found from dispatch" },
    });
    await dispatchError.app.close();
  });

  it("maps owner, transport, stale owner, and timeout failures consistently", async () => {
    const missingOwner = createBackgroundScheduleHarness({ createSession: false });
    expect(
      await missingOwner.app.inject({
        method: "GET",
        url: "/api/sessions/missing/background-tasks",
      }),
    ).toMatchObject({ statusCode: 404 });
    await missingOwner.app.close();

    const missingTransport = createBackgroundScheduleHarness({ attachTransport: false });
    expect(
      await missingTransport.app.inject({
        method: "GET",
        url: "/api/sessions/sess-contract/background-tasks",
      }),
    ).toMatchObject({ statusCode: 503 });
    expect(missingTransport.registry.getConnectedNode("fake-node")).toMatchObject({
      pendingCommandCount: 0,
    });
    await missingTransport.app.close();

    const staleOwner = createBackgroundScheduleHarness();
    staleOwner.registry.disconnectNode("fake-node", {
      connectionId: staleOwner.connectionId,
      reason: "test",
    });
    expect(
      await staleOwner.app.inject({
        method: "GET",
        url: "/api/sessions/sess-contract/schedules",
      }),
    ).toMatchObject({ statusCode: 503 });
    await staleOwner.app.close();

    const timeout = createBackgroundScheduleHarness({
      bridgeOverride: {
        sendPendingCommand: async () => {
          throw new PendingNodeCommandTimeoutError({
            commandType: "claude_runtime_list_tasks",
            requestId: "timeout-1",
            timeoutMs: 5,
          });
        },
      },
    });
    expect(
      await timeout.app.inject({
        method: "GET",
        url: "/api/sessions/sess-contract/background-tasks",
      }),
    ).toMatchObject({ statusCode: 503 });
    await timeout.app.close();
  });

  it("returns 400 for invalid background route bodies", async () => {
    const { app } = createBackgroundScheduleHarness();

    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/background-tasks/background",
        payload: [],
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/background-tasks/background",
        payload: { toolUseId: 123 },
      }),
    ).toMatchObject({ statusCode: 400 });

    await app.close();
  });

  it("can be registered directly on a Fastify instance for route-boundary tests", async () => {
    const { app: harnessApp, router, bridge } = createBackgroundScheduleHarness();
    const app = createApp({ config });

    registerSessionBackgroundScheduleRoutes(app, { router, bridge });

    expect(
      await app.inject({
        method: "GET",
        url: "/api/sessions/missing/background-tasks",
      }),
    ).toMatchObject({ statusCode: 404 });

    await harnessApp.close();
    await app.close();
  });
});

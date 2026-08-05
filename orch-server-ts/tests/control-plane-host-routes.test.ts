import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerFolderControlPlaneHostRoute } from "../src/folders/folder_control_plane_host_route.js";
import type { FolderControlPlaneService } from "../src/folders/folder_control_plane_service.js";
import { registerScheduleHostRoute } from "../src/schedule/schedule_host_route.js";
import type { SoulstreamScheduleRepository } from "../src/schedule/schedule_repository.js";
import { registerTaskControlPlaneHostRoute } from "../src/tasks/task_control_plane_host_route.js";
import type { TaskControlPlaneService } from "../src/tasks/task_control_plane_service.js";
import { registerPersistenceHostRoutes } from "../src/control_plane/persistence_host_routes.js";
import type { PersistenceHostRepositories } from "../src/control_plane/persistence_host_runtime.js";

const token = "service-token";
const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("control-plane host routes", () => {
  it("rejects a task mutation without agent provenance", async () => {
    const app = Fastify();
    apps.push(app);
    registerTaskControlPlaneHostRoute(app, {
      authBearerToken: token,
      serviceProvider: async () => ({}) as TaskControlPlaneService,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/host/create_section",
      headers: { authorization: `Bearer ${token}` },
      payload: { actor_kind: "agent", actor_session_id: null, task_id: "task-1", title: "S" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().detail.error.code).toBe("INVALID_TASK_HOST_ACTOR");
  });

  it("preserves task actor and idempotency fields across the host boundary", async () => {
    const setTaskStatus = vi.fn(async (input: unknown) => ({ input }));
    const app = Fastify();
    apps.push(app);
    registerTaskControlPlaneHostRoute(app, {
      authBearerToken: token,
      serviceProvider: async () => ({ setTaskStatus }) as unknown as TaskControlPlaneService,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/host/set_task_status",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        actor_kind: "agent",
        actor_session_id: "session-1",
        actor_user_id: null,
        task_id: "task-1",
        expected_version: 3,
        status: "completed",
        idempotency_key: "idem-1",
        reason: "done",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(setTaskStatus).toHaveBeenCalledWith({
      actorKind: "agent",
      actorSessionId: "session-1",
      actorUserId: null,
      taskId: "task-1",
      expectedVersion: 3,
      status: "completed",
      idempotencyKey: "idem-1",
      reason: "done",
    });
  });

  it("preserves a sessionless llm mutation actor", async () => {
    const createSection = vi.fn(async (input: unknown) => ({ input }));
    const app = Fastify();
    apps.push(app);
    registerTaskControlPlaneHostRoute(app, {
      authBearerToken: token,
      serviceProvider: async () => ({ createSection }) as unknown as TaskControlPlaneService,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/host/create_section",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        actor_kind: "llm",
        actor_session_id: null,
        task_id: "task-1",
        title: "Plan",
        idempotency_key: "llm-section-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(createSection).toHaveBeenCalledWith(expect.objectContaining({
      actorKind: "llm",
      actorSessionId: null,
    }));
  });

  it("returns version-conflict details across the task host boundary", async () => {
    const setItemStatus = vi.fn(async () => {
      throw Object.assign(new Error("stale item"), {
        statusCode: 409,
        targetKind: "item",
        targetId: "item-1",
        expectedVersion: 2,
        actualVersion: 3,
      });
    });
    const app = Fastify();
    apps.push(app);
    registerTaskControlPlaneHostRoute(app, {
      authBearerToken: token,
      serviceProvider: async () => ({ setItemStatus }) as unknown as TaskControlPlaneService,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/host/set_item_status",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        actor_kind: "agent",
        actor_session_id: "session-1",
        item_id: "item-1",
        expected_version: 2,
        status: "completed",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      detail: {
        error: {
          code: "TASK_VERSION_CONFLICT",
          details: { targetKind: "item", actualVersion: 3 },
        },
      },
    });
  });

  it("revives schedule timestamps before invoking the repository", async () => {
    let capturedInput: { now: unknown; claimedUntil: unknown } | undefined;
    const claimDueSchedules = vi.fn(async (input: { now: unknown; claimedUntil: unknown }) => {
      capturedInput = input;
      return [];
    });
    const app = Fastify();
    apps.push(app);
    registerScheduleHostRoute(app, {
      authBearerToken: token,
      repositoryProvider: async () => ({ claimDueSchedules }) as unknown as SoulstreamScheduleRepository,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/schedules/host/claim_due_schedules",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        node_id: "node-1",
        now: "2026-08-05T10:00:00.000Z",
        claim_token: "claim-1",
        claimed_until: "2026-08-05T10:01:00.000Z",
        limit: 5,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedInput?.now).toBeInstanceOf(Date);
    expect(capturedInput?.claimedUntil).toBeInstanceOf(Date);
  });

  it("keeps folder update columns and nullable values explicit", async () => {
    const updateFolder = vi.fn(async () => undefined);
    const app = Fastify();
    apps.push(app);
    registerFolderControlPlaneHostRoute(app, {
      authBearerToken: token,
      serviceProvider: async () => ({ updateFolder }) as unknown as FolderControlPlaneService,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/folders/host/update",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        folder_id: "folder-1",
        columns: ["settings", "parent_folder_id"],
        values: ["{\"color\":\"blue\"}", null],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updateFolder).toHaveBeenCalledWith(
      "folder-1",
      ["settings", "parent_folder_id"],
      ["{\"color\":\"blue\"}", null],
    );
    expect(response.json()).toBeNull();
  });

  it("returns explicit JSON null for a void schedule operation", async () => {
    const touchNodeHeartbeat = vi.fn(async () => undefined);
    const app = Fastify();
    apps.push(app);
    registerScheduleHostRoute(app, {
      authBearerToken: token,
      repositoryProvider: async () => ({ touchNodeHeartbeat }) as unknown as SoulstreamScheduleRepository,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/schedules/host/touch_node_heartbeat",
      headers: { authorization: `Bearer ${token}` },
      payload: { node_id: "node-1", now: "2026-08-05T10:00:00.000Z" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });

  it("revives nested background terminal timestamps before the atomic repository call", async () => {
    const terminalize = vi.fn(async (input: unknown) => ({ accepted: false, row: input }));
    const app = Fastify();
    apps.push(app);
    registerPersistenceHostRoutes(app, {
      authBearerToken: token,
      repositoryProvider: async () => ({
        claudeBackgroundTasks: { terminalize },
      }) as unknown as PersistenceHostRepositories,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/claude-runtime/host/terminalize_background_task",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        args: [{
          source_node: "node-1",
          session_id: "session-1",
          task_id: "task-1",
          status: "completed",
          close_reason: "done",
          terminal_revision: "1",
          observed_at: "2026-08-05T10:00:00.000Z",
          delivery: {
            delivery_id: "delivery-1",
            relation_key: "relation-1",
            intent: "runtime_followup",
            source: "claude",
            payload_hash: "hash",
            payload: {},
            created_at: "2026-08-05T10:00:00.000Z",
          },
        }],
      },
    });

    expect(response.statusCode).toBe(200);
    const input = terminalize.mock.calls[0]?.[0] as { observedAt: unknown; delivery: { createdAt: unknown } };
    expect(input.observedAt).toBeInstanceOf(Date);
    expect(input.delivery.createdAt).toBeInstanceOf(Date);
  });

  it("rejects persistence operations outside the explicit whitelist", async () => {
    const app = Fastify();
    apps.push(app);
    registerPersistenceHostRoutes(app, {
      authBearerToken: token,
      repositoryProvider: async () => ({}) as PersistenceHostRepositories,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/session-deliveries/host/query",
      headers: { authorization: `Bearer ${token}` },
      payload: { args: ["SELECT 1"] },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().detail.error.code).toBe("HOST_OPERATION_NOT_FOUND");
  });
});

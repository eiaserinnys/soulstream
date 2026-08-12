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
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { SessionDeliveryNotificationRepository } from
  "../src/control_plane/repositories/session_delivery_notification_repository.js";

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

  it("serializes string persistence results as JSON", async () => {
    const acknowledgeReview = vi.fn(async () => "acknowledged");
    const app = Fastify();
    apps.push(app);
    registerPersistenceHostRoutes(app, {
      authBearerToken: token,
      repositoryProvider: async () => ({
        sessionMutations: { acknowledgeReview },
      }) as unknown as PersistenceHostRepositories,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/session-data/host/acknowledge_review",
      headers: { authorization: `Bearer ${token}` },
      payload: { args: ["session-1", "acknowledge-session-1"] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(response.body)).toBe("acknowledged");
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

  it("round-trips an opaque payload from the soul client through the route into the repository", async () => {
    const {
      PersistenceHostTransport,
      SessionDeliveryNotificationHostClient,
    } = await vi.importActual<{
      PersistenceHostTransport: new (config: {
        orch: {
          baseUrl: string;
          headers: Record<string, string>;
        };
        logger: unknown;
      }) => unknown;
      SessionDeliveryNotificationHostClient: new (transport: unknown) => {
        stageWithQueuedDelivery(input: {
          deliveryId: string;
          leaseOwner: string;
          targetSessionId: string;
          disposition: "queued" | "auto_resume";
          payload: Record<string, unknown>;
        }): Promise<unknown>;
      };
    }>("../../soul-server-ts/src/control_plane/persistence_host_clients.ts");
    let storedPayload: unknown;
    const leaseExpiresAt = new Date("2026-08-12T00:01:00.000Z");
    const query = Object.assign(
      async (strings: TemplateStringsArray) => {
        const statement = strings.join("?");
        if (statement.includes("UPDATE session_deliveries")) {
          return [{ lease_expires_at: leaseExpiresAt }];
        }
        if (statement.includes("INSERT INTO session_delivery_notification_outbox")) {
          return [];
        }
        throw new Error(`unexpected SQL: ${statement}`);
      },
      {
        begin: async (callback: (transaction: unknown) => Promise<unknown>) =>
          await callback(query),
        json: (value: unknown) => {
          storedPayload = value;
          return value;
        },
      },
    ) as unknown as SqlClient;
    const notifications = new SessionDeliveryNotificationRepository(query);
    const app = Fastify();
    apps.push(app);
    registerPersistenceHostRoutes(app, {
      authBearerToken: token,
      repositoryProvider: async () => ({
        deliveries: { notifications },
      }) as unknown as PersistenceHostRepositories,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new SessionDeliveryNotificationHostClient(
      new PersistenceHostTransport({
        orch: {
          baseUrl: address,
          headers: { authorization: `Bearer ${token}` },
        },
        logger: { warn: vi.fn() } as never,
      }),
    );
    const payload = {
      text: "completed",
      user: "agent",
      caller_info: {
        source: "agent",
        display_name: "로젤린",
        mixedCaseProof: "preserved",
      },
      source: "session-a",
      delivery_id: "delivery-1",
      delivery_intent: "completion_notification",
      completion_id: "completion-1",
      relation_key: "relation-1",
      disposition: "queued",
    };

    await expect(client.stageWithQueuedDelivery({
      deliveryId: "delivery-1",
      leaseOwner: "worker-1",
      targetSessionId: "target-1",
      disposition: "queued",
      payload,
    })).resolves.not.toBeNull();

    expect(storedPayload).toEqual(payload);
  });

  it("routes runner transcript correlation to the idempotent repository method", async () => {
    const appendClaudeTranscriptEntriesIdempotent = vi.fn(async () => 1);
    const app = Fastify();
    apps.push(app);
    registerPersistenceHostRoutes(app, {
      authBearerToken: token,
      repositoryProvider: async () => ({
        claudeTranscripts: { appendClaudeTranscriptEntriesIdempotent },
      }) as unknown as PersistenceHostRepositories,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/claude-runtime/host/append_transcript_entries_idempotent",
      headers: { authorization: `Bearer ${token}` },
      payload: { args: [{
        idempotency_key: "runner:append:1",
        session_id: "soul-session-a",
        key: { project_key: "project-a", session_id: "session-a" },
        entries: [],
      }] },
    });

    expect(response.statusCode).toBe(200);
    expect(appendClaudeTranscriptEntriesIdempotent).toHaveBeenCalledWith({
      idempotencyKey: "runner:append:1",
      sessionId: "soul-session-a",
      key: { projectKey: "project-a", sessionId: "session-a" },
      entries: [],
    });
  });

  it("preserves session transition fields, idempotency, and timestamps across the host boundary", async () => {
    const transitionSession = vi.fn(async (input: unknown) => ({ input }));
    const app = Fastify();
    apps.push(app);
    registerPersistenceHostRoutes(app, {
      authBearerToken: token,
      repositoryProvider: async () => ({
        sessionMutations: { transitionSession },
      }) as unknown as PersistenceHostRepositories,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/session-data/host/transition_session",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        args: [{
          session_id: "session-1",
          fields: {
            status: "interrupted",
            last_read_event_id: 12,
            termination_reason: "killed",
          },
          idempotency_key: "transition-session-1",
          updated_at: "2026-08-06T10:00:00.000Z",
        }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(transitionSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      fields: {
        status: "interrupted",
        lastReadEventId: 12,
        terminationReason: "killed",
      },
      idempotencyKey: "transition-session-1",
      updatedAt: new Date("2026-08-06T10:00:00.000Z"),
    });
  });

  it("dispatches every session-data read operation through the explicit whitelist", async () => {
    const targets = {
      getSession: vi.fn(async () => null),
      listSessionsSummary: vi.fn(async () => ({ sessions: [], total: 0 })),
      listRunningSessionsSummary: vi.fn(async () => ({ sessions: [], total: 0 })),
      listSessionsForUpstreamDump: vi.fn(async () => ({ sessions: [], total: 0 })),
      countEvents: vi.fn(async () => 0),
      readEvents: vi.fn(async () => []),
      readOneEvent: vi.fn(async () => null),
      streamEventsRaw: vi.fn(async () => []),
      searchEvents: vi.fn(async () => []),
      searchEventsBySessionId: vi.fn(async () => []),
      getSessionSearchMetadata: vi.fn(async () => []),
      countTurnSummaries: vi.fn(async () => ({ totalCount: 0, digestedCount: 0, undigestedCount: 0 })),
      loadTurnSummaryRange: vi.fn(async () => []),
      searchSessionDigests: vi.fn(async () => []),
      getSessionStory: vi.fn(async () => ({
        highlight: null,
        narrative: null,
        unfoldedTurnSummaries: [],
        narrativeThroughEventId: null,
        foldCount: 0,
        updatedAt: null,
      })),
      getTurnExcerpt: vi.fn(async () => ({ totalEvents: 0, turns: [] })),
      getResumeContext: vi.fn(async () => ({
        session: null,
        folderSessions: { sessions: [], total: 0 },
        runningSessions: { sessions: [], total: 0 },
        predecessor: null,
      })),
    };
    const repositories = {
      sessionReads: targets,
      eventReads: targets,
      storyReads: targets,
      sessionReadComposites: targets,
    } as unknown as PersistenceHostRepositories;
    const app = Fastify();
    apps.push(app);
    registerPersistenceHostRoutes(app, {
      authBearerToken: token,
      repositoryProvider: async () => repositories,
    });
    const operations = [
      ["get", "getSession"],
      ["list_summary", "listSessionsSummary"],
      ["list_running", "listRunningSessionsSummary"],
      ["upstream_dump", "listSessionsForUpstreamDump"],
      ["event_count", "countEvents"],
      ["event_read_page", "readEvents"],
      ["event_read_one", "readOneEvent"],
      ["event_raw_page", "streamEventsRaw"],
      ["event_search", "searchEvents"],
      ["event_session_id_search", "searchEventsBySessionId"],
      ["story_search_metadata", "getSessionSearchMetadata"],
      ["turn_summary_count", "countTurnSummaries"],
      ["turn_summary_range", "loadTurnSummaryRange"],
      ["digest_search", "searchSessionDigests"],
      ["story", "getSessionStory"],
      ["turn_excerpt", "getTurnExcerpt"],
      ["resume_context", "getResumeContext"],
    ] as const;

    for (const [operation, method] of operations) {
      const response = await app.inject({
        method: "POST",
        url: `/api/session-data/host/${operation}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { args: [] },
      });
      expect(response.statusCode, operation).toBe(200);
      expect(targets[method]).toHaveBeenCalledTimes(1);
    }
  });

  it("returns idempotency conflicts across the session mutation host boundary", async () => {
    const deleteSession = vi.fn(async () => {
      throw Object.assign(new Error("idempotency key conflict: delete-session-1"), {
        statusCode: 409,
      });
    });
    const app = Fastify();
    apps.push(app);
    registerPersistenceHostRoutes(app, {
      authBearerToken: token,
      repositoryProvider: async () => ({
        sessionMutations: { deleteSession },
      }) as unknown as PersistenceHostRepositories,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/session-data/host/delete_session",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        args: [{
          session_id: "session-1",
          idempotency_key: "delete-session-1",
        }],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      detail: {
        error: {
          code: "HOST_OPERATION_FAILED",
          message: "idempotency key conflict: delete-session-1",
        },
      },
    });
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

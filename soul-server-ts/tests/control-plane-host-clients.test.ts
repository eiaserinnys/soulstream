import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FolderHostClient } from "../src/folder/folder_host_client.js";
import { ScheduleHostClient } from "../src/schedule/schedule_host_client.js";
import { TaskVersionConflict } from "../src/work-task/task_models.js";
import { TaskService } from "../src/work-task/task_service.js";
import {
  ClaudeRuntimeHostClient,
  PersistenceHostTransport,
  SessionDeliveryNotificationHostClient,
} from "../src/control_plane/persistence_host_clients.js";

const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
const orch = { baseUrl: "https://orch.example", headers: { authorization: "Bearer token" } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("worker control-plane host clients", () => {
  it("records all four persistence host round-trip timestamps", async () => {
    const info = vi.fn();
    const timingLogger = { info, warn: vi.fn() } as unknown as Logger;
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_300);
    let requestId = "";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      requestId = new Headers(init?.headers).get("x-soulstream-persistence-request-id") ?? "";
      return new Response("null", {
        status: 200,
        headers: {
          "x-soulstream-persistence-request-id": requestId,
          "x-soulstream-host-received-at-ms": "1100",
          "x-soulstream-host-responded-at-ms": "1200",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const transport = new PersistenceHostTransport({ orch, logger: timingLogger });

    await expect(transport.request("session-data", "get", ["session-a"])).resolves.toBeNull();

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(info).toHaveBeenCalledWith(
      {
        requestId,
        domain: "session-data",
        operation: "get",
        status: 200,
        nodeRequestedAtMs: 1_000,
        hostReceivedAtMs: 1_100,
        hostRespondedAtMs: 1_200,
        nodeResponseReadAtMs: 1_300,
        requestToHostMs: 100,
        hostProcessingMs: 100,
        hostToResponseReadMs: 100,
        totalDurationMs: 300,
      },
      "persistence host request completed",
    );
    now.mockRestore();
  });

  it("keeps the correlation id and node timestamps when a response is never read", async () => {
    const warn = vi.fn();
    const timingLogger = { info: vi.fn(), warn } as unknown as Logger;
    const timeout = new Error("The operation was aborted due to timeout");
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(12_000);
    let requestId = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestId = new Headers(init?.headers).get("x-soulstream-persistence-request-id") ?? "";
      throw timeout;
    }));
    const transport = new PersistenceHostTransport({ orch, logger: timingLogger });

    await expect(transport.request("session-deliveries", "release_expired_delivery_leases", []))
      .rejects.toMatchObject({ name: "PersistenceHostRequestError" });

    expect(warn).toHaveBeenCalledWith(
      {
        requestId,
        domain: "session-deliveries",
        operation: "release_expired_delivery_leases",
        nodeRequestedAtMs: 2_000,
        nodeRequestFailedAtMs: 12_000,
        totalDurationMs: 10_000,
        err: timeout,
      },
      "persistence host request failed before response",
    );
    now.mockRestore();
  });

  it("distinguishes response body read failure from a request that never reached the host", async () => {
    const warn = vi.fn();
    const timingLogger = { info: vi.fn(), warn } as unknown as Logger;
    const readError = new Error("response body stalled");
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(3_000)
      .mockReturnValueOnce(13_000);
    let requestId = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestId = new Headers(init?.headers).get("x-soulstream-persistence-request-id") ?? "";
      const body = new ReadableStream({
        start(controller) {
          controller.error(readError);
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "x-soulstream-persistence-request-id": requestId,
          "x-soulstream-host-received-at-ms": "3100",
          "x-soulstream-host-responded-at-ms": "3200",
        },
      });
    }));
    const transport = new PersistenceHostTransport({ orch, logger: timingLogger });

    await expect(transport.request("session-data", "get", ["session-a"]))
      .rejects.toMatchObject({
        name: "PersistenceHostRequestError",
        status: undefined,
        retryable: true,
      });

    expect(warn).toHaveBeenCalledWith(
      {
        requestId,
        domain: "session-data",
        operation: "get",
        nodeRequestedAtMs: 3_000,
        nodeRequestFailedAtMs: 13_000,
        totalDurationMs: 10_000,
        status: 200,
        hostReceivedAtMs: 3_100,
        hostRespondedAtMs: 3_200,
        err: readError,
      },
      "persistence host response read failed",
    );
    now.mockRestore();
  });

  it("serializes task provenance in snake_case and dispatches a returned handoff", async () => {
    const notifyHumanHandoff = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({
        actor_kind: "agent",
        actor_session_id: "session-1",
        item_id: "item-1",
        expected_version: 4,
        idempotency_key: "idem-1",
      });
      return new Response(JSON.stringify({
        snapshot: { task: { id: "task-1" }, sections: [], items: [] },
        operation: { id: "operation-1" },
        eventId: 12,
        handoff: {
          taskId: "task-1",
          taskTitle: "Task",
          boardItemId: "task:task-1",
          itemId: "item-1",
          itemTitle: "Item",
          status: "completed",
          operationId: "operation-1",
          eventId: 12,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new TaskService({ orch, logger });
    service.setHandoffNotifier({ notifyHumanHandoff });

    await service.setItemStatus({
      actorSessionId: "session-1",
      itemId: "item-1",
      expectedVersion: 4,
      status: "completed",
      idempotencyKey: "idem-1",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://orch.example/api/tasks/host/set_item_status");
    expect(notifyHumanHandoff).toHaveBeenCalledOnce();
  });

  it("sends schedule claims only to the explicit schedule host operation", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ScheduleHostClient({ orch, logger });

    await client.claimDueSchedules({
      nodeId: "node-1",
      now: new Date("2026-08-05T10:00:00.000Z"),
      claimToken: "claim-1",
      claimedUntil: new Date("2026-08-05T10:01:00.000Z"),
      limit: 2,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://orch.example/api/schedules/host/claim_due_schedules");
  });

  it("restores a task version conflict returned by the host", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      detail: {
        error: {
          code: "TASK_VERSION_CONFLICT",
          message: "stale item",
          details: {
            targetKind: "item",
            targetId: "item-1",
            expectedVersion: 2,
            actualVersion: 3,
          },
        },
      },
    }), { status: 409, headers: { "content-type": "application/json" } })));
    const service = new TaskService({ orch, logger });

    await expect(service.setItemStatus({
      actorSessionId: "session-1",
      itemId: "item-1",
      expectedVersion: 2,
      status: "completed",
    })).rejects.toBeInstanceOf(TaskVersionConflict);
  });

  it("uses the folder host for session assignment", async () => {
    const fetchMock = vi.fn(async () => new Response("null", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FolderHostClient({ orch, logger });

    await client.assignSessionToFolder("session-1", "folder-1");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://orch.example/api/folders/host/assign_session");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      session_id: "session-1",
      folder_id: "folder-1",
    });
  });

  it("serializes background terminalize and its delivery identity in one request", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.args[0]).toMatchObject({
        source_node: "node-1",
        session_id: "session-1",
        task_id: "task-1",
        terminal_revision: "1",
        delivery: {
          delivery_id: "delivery-1",
          relation_key: "relation-1",
          payload_hash: "hash",
        },
      });
      return new Response(JSON.stringify({
        accepted: false,
        row: {
          source_node: "node-1",
          session_id: "session-1",
          task_id: "task-1",
          created_at: "2026-08-05T10:00:00.000Z",
        },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ClaudeRuntimeHostClient({ orch, logger });

    const result = await client.terminalize({
      sourceNode: "node-1",
      sessionId: "session-1",
      taskId: "task-1",
      status: "completed",
      closeReason: "done",
      terminalRevision: "1",
      delivery: {
        deliveryId: "delivery-1",
        relationKey: "relation-1",
        intent: "runtime_followup",
        source: "claude",
        payloadHash: "hash",
        payload: {},
      },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://orch.example/api/claude-runtime/host/terminalize_background_task",
    );
    expect(result.row.created_at).toBeInstanceOf(Date);
  });

  it("preserves notification payload casing as an opaque host argument subtree", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.args[0]).toEqual({
        delivery_id: "delivery-1",
        lease_owner: "worker-1",
        target_session_id: "target-1",
        disposition: "queued",
        payload: {
          delivery_id: "delivery-1",
          caller_info: {
            display_name: "로젤린",
            mixedCaseProof: "preserved",
          },
        },
      });
      return new Response("null", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SessionDeliveryNotificationHostClient(
      new PersistenceHostTransport({ orch, logger }),
    );

    await client.stageWithQueuedDelivery({
      deliveryId: "delivery-1",
      leaseOwner: "worker-1",
      targetSessionId: "target-1",
      disposition: "queued",
      payload: {
        delivery_id: "delivery-1",
        caller_info: {
          display_name: "로젤린",
          mixedCaseProof: "preserved",
        },
      },
    });
  });

  it("uses explicit notification dead-letter list and requeue host operations", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const operation = new URL(url).pathname.split("/").at(-1);
      if (operation === "list_dead_letter_notifications") {
        expect(JSON.parse(String(init?.body))).toEqual({ args: [25] });
        return new Response("[]", { status: 200 });
      }
      expect(operation).toBe("requeue_dead_letter_notification");
      expect(JSON.parse(String(init?.body))).toEqual({ args: ["delivery-1"] });
      return new Response("null", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SessionDeliveryNotificationHostClient(
      new PersistenceHostTransport({ orch, logger }),
    );

    await expect(client.listDeadLetters(25)).resolves.toEqual([]);
    await expect(client.requeueDeadLetter("delivery-1")).resolves.toBeNull();
  });

  it("sends runner transcript correlation to the idempotent mutation owner", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        args: [{
          idempotency_key: "runner:append:1",
          session_id: "soul-session-a",
          key: { project_key: "project-a", session_id: "session-a" },
          entries: [{ type: "user", message: { content: "hello" } }],
        }],
      });
      return new Response("1", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ClaudeRuntimeHostClient({ orch, logger });

    await client.appendClaudeTranscriptEntriesIdempotent({
      idempotencyKey: "runner:append:1",
      sessionId: "soul-session-a",
      key: { projectKey: "project-a", sessionId: "session-a" },
      entries: [{ type: "user", message: { content: "hello" } }] as never,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://orch.example/api/claude-runtime/host/append_transcript_entries_idempotent",
    );
  });
});

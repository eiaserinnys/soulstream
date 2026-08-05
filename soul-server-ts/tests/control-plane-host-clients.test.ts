import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FolderHostClient } from "../src/folder/folder_host_client.js";
import { ScheduleHostClient } from "../src/schedule/schedule_host_client.js";
import { TaskVersionConflict } from "../src/work-task/task_models.js";
import { TaskService } from "../src/work-task/task_service.js";
import {
  ClaudeRuntimeHostClient,
} from "../src/control_plane/persistence_host_clients.js";

const logger = { warn: vi.fn() } as unknown as Logger;
const orch = { baseUrl: "https://orch.example", headers: { authorization: "Bearer token" } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("worker control-plane host clients", () => {
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
});

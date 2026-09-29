import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FolderHostClient } from "../src/folder/folder_host_client.js";
import { ScheduleHostClient } from "../src/schedule/schedule_host_client.js";
import { FolderVersionConflict } from "../src/folder/folder_models.js";
import { FolderService } from "../src/folder/folder_service.js";
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

    await expect(transport.request("session-deliveries", "expire_stale_delivery_attempts", []))
      .rejects.toMatchObject({ name: "PersistenceHostRequestError" });

    expect(warn).toHaveBeenCalledWith(
      {
        requestId,
        domain: "session-deliveries",
        operation: "expire_stale_delivery_attempts",
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

  it("serializes checklist mutation input and returns the host mutation result", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({
        actor_kind: "agent",
        actor_session_id: "session-1",
        folder_id: "folder-1",
        item_id: "item-1",
        expected_version: 4,
        idempotency_key: "idem-1",
      });
      return new Response(JSON.stringify({
        folderId: "folder-1",
        item: { id: "item-1", status: "completed" },
        operation: { id: "operation-1" },
        idempotent: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new FolderService({ orch, logger });

    const result = await service.setChecklistItemStatus({
      actorSessionId: "session-1",
      folderId: "folder-1",
      itemId: "item-1",
      expectedVersion: 4,
      status: "completed",
      idempotencyKey: "idem-1",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://orch.example/api/folders/host/set_checklist_item_status");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeDefined();
    expect(result).toEqual({
      folderId: "folder-1",
      item: { id: "item-1", status: "completed" },
      operation: { id: "operation-1" },
      idempotent: false,
    });
  });

  it("parses both orchestrator host error envelope shapes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "BAD_INPUT", message: "invalid folder", details: { field: "name" } },
    }), { status: 400 })));
    const client = new FolderService({ orch, logger });

    await expect(client.createFolder({
      actorKind: "system",
      actorSessionId: null,
      name: "",
      sortOrder: 0,
      parentFolderId: null,
      idempotencyKey: "idem-1",
    })).rejects.toMatchObject({
      message: "folder host create_folder failed: invalid folder",
    });
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

  it("sends only immutable schedule identity and the worker-observed current revision", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response("true", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ScheduleHostClient({ orch, logger });

    const allowed = await client.hasContinuousLimitWindow({
      scheduleId: "resume-after-limit:sess-1:3232:0",
      sessionId: "sess-1",
      sourceTool: "ResumeAfterLimit",
      toolUseId: "ResumeAfterLimit:3232",
    } as never, 3259);

    expect(allowed).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://orch.example/api/schedules/host/has_continuous_limit_window",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      schedule: {
        schedule_id: "resume-after-limit:sess-1:3232:0",
        session_id: "sess-1",
        source_tool: "ResumeAfterLimit",
        tool_use_id: "ResumeAfterLimit:3232",
      },
      expected_current_terminal_id: 3259,
    });
  });

  it("restores a folder version conflict returned by the host", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      detail: {
        error: {
          code: "FOLDER_VERSION_CONFLICT",
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
    const service = new FolderService({ orch, logger });

    await expect(service.setChecklistItemStatus({
      actorSessionId: "session-1",
      folderId: "folder-1",
      itemId: "item-1",
      expectedVersion: 2,
      status: "completed",
    })).rejects.toBeInstanceOf(FolderVersionConflict);
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

  it("reads a folder header from the canonical folder snapshot host operation", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      folder: {
        id: "folder-1", name: "Work", checklistEnabled: true, status: "open",
        version: 4, settings: { folderPrompt: "Guide" }, parentFolderId: null,
      },
      sections: [], items: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new FolderHostClient({ orch, logger });

    await expect(client.getFolderById("folder-1")).resolves.toMatchObject({
      id: "folder-1", name: "Work", checklist_enabled: true,
      settings: { folderPrompt: "Guide" }, parent_folder_id: null,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://orch.example/api/folders/host/get_folder");
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
        attempt_token: "worker-1",
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
      attemptToken: "worker-1",
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

  it("scopes Claude background recovery reads to one runner session", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.args).toEqual(["node-1", "session-1", 1_000]);
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ClaudeRuntimeHostClient({ orch, logger });

    await expect(
      client.activeForSession("node-1", "session-1"),
    ).resolves.toEqual([]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://orch.example/api/claude-runtime/host/active_background_tasks_for_session",
    );
  });

  it("routes canonical background generation identity without collapsing it to task id", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        args: [
          "node-1",
          "session-1",
          "sdk-session-1",
          "task-1",
          "toolu-resume-1",
        ],
      });
      return new Response(JSON.stringify({
        source_node: "node-1",
        session_id: "session-1",
        sdk_session_id: "sdk-session-1",
        task_id: "task-1",
        initiating_tool_use_id: "toolu-resume-1",
        created_at: "2026-09-05T09:27:55.000Z",
        updated_at: "2026-09-05T09:27:55.000Z",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ClaudeRuntimeHostClient({ orch, logger });

    const row = await client.getGeneration(
      "node-1",
      "session-1",
      "sdk-session-1",
      "task-1",
      "toolu-resume-1",
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://orch.example/api/claude-runtime/host/get_background_generation",
    );
    expect(row?.created_at).toBeInstanceOf(Date);
  });

  it("sends exact execution recovery and legacy terminal inventory dimensions", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(JSON.stringify(JSON.parse(String(init?.body)).args), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ClaudeRuntimeHostClient({ orch, logger });

    await expect(client.activeGenerationsForExecution(
      "node-1",
      "session-1",
      "registration-1",
      "command-1",
    )).resolves.toEqual([
      "node-1", "session-1", "registration-1", "command-1", 1_000,
    ]);
    await expect(client.terminalForNode("node-1")).resolves.toEqual([
      "node-1", 1_000,
    ]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://orch.example/api/claude-runtime/host/active_background_generations_for_execution",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://orch.example/api/claude-runtime/host/terminal_background_tasks_for_node",
    );
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

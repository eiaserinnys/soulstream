import { describe, expect, it, vi } from "vitest";

import { ChecklistMutationCore } from "../src/tasks/control_plane/task_mutation_core.js";
import type { ChecklistRepository } from "../src/tasks/control_plane/task_repository.js";
import type {
  RepositorySql,
  FolderDbPort,
  FolderOperationRow,
  FolderSnapshot,
} from "../src/tasks/control_plane/task_types.js";

describe("ChecklistMutationCore orchestrator transaction", () => {
  it("commits actor event, domain mutation, and operation with the same provenance", async () => {
    const order: string[] = [];
    const operation: FolderOperationRow = {
      id: "operation-1",
      folder_id: "task-1",
      target_kind: "section",
      target_id: "section-1",
      operation_type: "update_checklist_section",
      actor_kind: "agent",
      actor_session_id: "session-1",
      actor_event_id: 42,
      actor_user_id: null,
      idempotency_key: "idem-1",
      payload_json: { title: "Renamed" },
      reason: "test",
      created_at: new Date("2026-08-05T00:00:00.000Z"),
    };
    const snapshot = {
      folder: {
        id: "task-1",
        parent_folder_id: null, project_page_id: "page-1", sort_order: 0, settings: {}, checklist_enabled: false,
        name: "Folder",
        status: "open",
        archived: false,
        version: 1,
        created_session_id: "session-1",
        created_event_id: 1,
        completed_kind: null,
        completed_session_id: null,
        completed_event_id: null,
        completed_user_id: null,
        completed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      sections: [],
      items: [],
    } satisfies FolderSnapshot;
    const transactionSql = {} as RepositorySql;
    const appendOperationTx = vi.fn(async (_sql, input) => {
      order.push("operation");
      expect(input).toMatchObject({
        actorKind: "agent",
        actorSessionId: "session-1",
        actorEventId: 42,
        idempotencyKey: "idem-1",
      });
      return operation;
    });
    const repo = {
      transaction: async (callback: (sql: RepositorySql) => Promise<unknown>) => {
        order.push("begin");
        const result = await callback(transactionSql);
        order.push("commit");
        return result;
      },
      getOperationByIdempotencyKey: vi.fn(async () => null),
      appendOperationTx,
      getSnapshot: vi.fn(async () => snapshot),
    } as unknown as ChecklistRepository;
    const db: FolderDbPort = {
      async appendEventTx(sql, input) {
        expect(sql).toBe(transactionSql);
        expect(input).toMatchObject({ sessionId: "session-1", eventType: "folder_operation" });
        order.push("event");
        return 42;
      },
    };
    const broadcaster = { emitFolderUpdated: vi.fn(async () => undefined) };
    const core = new ChecklistMutationCore(db, repo, broadcaster);

    const result = await core.mutate({
      folderId: "task-1",
      targetKind: "section",
      targetId: "section-1",
      operationType: "update_checklist_section",
      actor: { actorKind: "agent", actorSessionId: "session-1" },
      payload: { title: "Renamed" },
      reason: "test",
      idempotencyKey: "idem-1",
      apply: async (sql, eventId) => {
        expect(sql).toBe(transactionSql);
        expect(eventId).toBe(42);
        order.push("apply");
      },
    });

    expect(order).toEqual(["begin", "event", "apply", "operation", "commit"]);
    expect(result).toMatchObject({ eventId: 42, operation: { actor_session_id: "session-1" } });
    expect(broadcaster.emitFolderUpdated).toHaveBeenCalledWith(
      "task-1",
      "session-1",
      false,
    );
  });
});

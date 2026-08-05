import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskVersionConflict } from "../../../orch-server-ts/src/tasks/control_plane/task_models.js";
import type {
  SqlClient,
  TaskDbPort,
} from "../../../orch-server-ts/src/tasks/control_plane/task_types.js";
import { TaskControlPlaneService } from "../../../orch-server-ts/src/tasks/task_control_plane_service.js";
import {
  createTaskPostgresHarness,
  hasTaskPostgresBackend,
  resetTaskData,
  type TaskPostgresHarness,
} from "./task_postgres_harness.js";

const describePostgres = hasTaskPostgresBackend ? describe : describe.skip;

describePostgres("Task control-plane PostgreSQL integration", () => {
  let harness: TaskPostgresHarness;
  let service: TaskControlPlaneService;
  const emitTaskUpdated = vi.fn(async () => undefined);

  beforeAll(async () => {
    harness = await createTaskPostgresHarness();
  }, 45_000);

  beforeEach(async () => {
    await resetTaskData(harness.sql);
    await seedTask(harness, "task-1");
    emitTaskUpdated.mockClear();
    service = new TaskControlPlaneService(
      harness.sql as unknown as SqlClient,
      createTaskDbPort(),
      { emitTaskUpdated },
    );
  });

  afterAll(async () => {
    await harness?.cleanup();
  }, 15_000);

  it("commits item status, audit event, operation, and handoff with one provenance", async () => {
    await service.createSection({
      taskId: "task-1",
      sectionId: "section-1",
      title: "Work",
      actorKind: "agent",
      actorSessionId: "sess-actor",
      idempotencyKey: "section:create",
    });
    await service.createItem({
      taskId: "task-1",
      sectionId: "section-1",
      itemId: "item-1",
      title: "Ship",
      actorKind: "agent",
      actorSessionId: "sess-actor",
      idempotencyKey: "item:create",
    });

    const result = await service.setItemStatus({
      itemId: "item-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "user@example.com",
      idempotencyKey: "item:complete",
    });

    expect(result).toMatchObject({
      eventId: expect.any(Number),
      operation: {
        actor_kind: "user",
        actor_session_id: "sess-actor",
        actor_user_id: "user@example.com",
      },
      handoff: {
        taskId: "task-1",
        itemId: "item-1",
        status: "completed",
      },
    });
    const rows = await harness.sql<Array<{
      updated_event_id: number;
      actor_event_id: number;
      completed_user_id: string;
    }>>`
      SELECT item.updated_event_id, operation.actor_event_id, item.completed_user_id
      FROM task_items item
      JOIN task_operations operation ON operation.id = ${result.operation.id}
      WHERE item.id = 'item-1'
    `;
    expect(rows).toEqual([{
      updated_event_id: result.eventId,
      actor_event_id: result.eventId,
      completed_user_id: "user@example.com",
    }]);
    expect(emitTaskUpdated).toHaveBeenCalledWith("sess-actor", "task-1", "task:task-1");
  });

  it("rejects a stale version before appending audit state", async () => {
    await service.createSection({
      taskId: "task-1",
      sectionId: "section-1",
      title: "Work",
      actorKind: "agent",
      actorSessionId: "sess-actor",
    });
    await service.createItem({
      taskId: "task-1",
      sectionId: "section-1",
      itemId: "item-1",
      title: "Ship",
      actorKind: "agent",
      actorSessionId: "sess-actor",
    });
    const before = await auditCounts(harness);

    await expect(service.setItemStatus({
      itemId: "item-1",
      expectedVersion: 9,
      status: "completed",
      actorKind: "agent",
      actorSessionId: "sess-actor",
    })).rejects.toBeInstanceOf(TaskVersionConflict);
    expect(await auditCounts(harness)).toEqual(before);
  });

  it("replays an idempotency key without duplicating rows or broadcasts", async () => {
    const input = {
      taskId: "task-1",
      sectionId: "section-1",
      title: "Work",
      actorKind: "agent" as const,
      actorSessionId: "sess-actor",
      idempotencyKey: "section:create:once",
    };
    const first = await service.createSection(input);
    emitTaskUpdated.mockClear();
    const replay = await service.createSection(input);

    expect(replay).toMatchObject({ idempotent: true, operation: { id: first.operation.id } });
    const rows = await harness.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM task_sections WHERE task_id = 'task-1'
    `;
    expect(rows[0]?.count).toBe(1);
    expect(emitTaskUpdated).not.toHaveBeenCalled();
  });

  it("derives my-turn items from the section human assignee", async () => {
    await service.createSection({
      taskId: "task-1",
      sectionId: "section-1",
      title: "Human",
      assignee: { kind: "human", userId: "user@example.com" },
      actorKind: "agent",
      actorSessionId: "sess-actor",
    });
    await service.createItem({
      taskId: "task-1",
      sectionId: "section-1",
      itemId: "item-1",
      title: "Review",
      actorKind: "agent",
      actorSessionId: "sess-actor",
    });

    await expect(service.listMyTurnItems({ userId: "user@example.com" })).resolves.toEqual([
      expect.objectContaining({ item_id: "item-1", effective_assignee_kind: "human" }),
    ]);
  });

  function createTaskDbPort(): TaskDbPort {
    return {
      async appendEventTx(sql, input) {
        const rows = await sql<readonly { event_append: number }[]>`
          SELECT event_append(
            ${input.sessionId}, ${input.eventType}, ${input.payload},
            ${input.searchableText}, ${input.createdAt}, ${input.dedupeKey ?? null}
          ) AS event_append
        `;
        const eventId = rows[0]?.event_append;
        if (typeof eventId !== "number") throw new Error("event_append returned no event id");
        return eventId;
      },
    };
  }
});

async function seedTask(harness: TaskPostgresHarness, taskId: string): Promise<void> {
  await harness.sql`
    INSERT INTO board_items (
      id, folder_id, container_kind, container_id, item_type, item_id, metadata
    ) VALUES (
      ${`task:${taskId}`}, 'folder-1', 'folder', 'folder-1', 'task', ${taskId},
      ${JSON.stringify({ title: "Task" })}::jsonb
    )
  `;
  await harness.sql`
    INSERT INTO tasks (id, board_item_id, title, created_session_id)
    VALUES (${taskId}, ${`task:${taskId}`}, 'Task', 'sess-actor')
  `;
}

async function auditCounts(harness: TaskPostgresHarness): Promise<{ events: number; operations: number }> {
  const rows = await harness.sql<Array<{ events: number; operations: number }>>`
    SELECT
      (SELECT COUNT(*)::int FROM events) AS events,
      (SELECT COUNT(*)::int FROM task_operations) AS operations
  `;
  return rows[0] ?? { events: 0, operations: 0 };
}

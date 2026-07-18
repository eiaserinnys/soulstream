import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardYjsService } from "../../src/collaboration/board_yjs_service.js";
import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
import { TaskHandoffNotifier } from "../../src/work-task/task_handoff_notifier.js";
import { TaskVersionConflict } from "../../src/work-task/task_models.js";
import { TaskService } from "../../src/work-task/task_service.js";
import {
  createTaskPostgresHarness,
  hasTaskPostgresBackend,
  resetTaskData,
  type TaskPostgresHarness,
} from "./task_postgres_harness.js";

const hasPostgresTestBackend = hasTaskPostgresBackend;
const describePostgres = hasPostgresTestBackend ? describe : describe.skip;

describePostgres("TaskService PostgreSQL integration", () => {
  let harness: TaskPostgresHarness | undefined;
  let db: SessionDB;
  let boardYjsService: BoardYjsService | undefined;
  let service: TaskService;
  let emitTaskUpdated: ReturnType<typeof vi.fn>;
  let notifyHumanHandoff: ReturnType<typeof vi.fn>;
  const observedOperationCounts: number[] = [];

  beforeAll(async () => {
    harness = await createTaskPostgresHarness();
    db = new SessionDB(harness.sql);
    emitTaskUpdated = vi.fn(async (actorSessionId: string, taskId: string) => {
      if (actorSessionId === "sess-actor") {
        observedOperationCounts.push(
          (await db.tasks().listOperations(taskId)).length,
        );
      }
    });
    notifyHumanHandoff = vi.fn();
  }, 45_000);

  beforeEach(async () => {
    if (!harness) return;
    await boardYjsService?.close();
    await resetTaskData(harness.sql);
    boardYjsService = createTestBoardYjsService(db);
    service = new TaskService(
      db,
      { emitTaskUpdated },
      boardYjsService,
      { notifyHumanHandoff },
    );
    emitTaskUpdated.mockClear();
    notifyHumanHandoff.mockClear();
    observedOperationCounts.length = 0;
  }, 15_000);

  afterAll(async () => {
    await boardYjsService?.close();
    await harness?.cleanup();
  }, 15_000);

  it("creates a first-class task board item and links it 1:1", async () => {
    const result = await service.createTask({
      taskId: "rb-1",
      folderId: "folder-1",
      title: "Task",
      x: 120,
      y: 240,
      actorSessionId: "sess-actor",
    });

    const rows = await harness!.sql<Array<{
      board_item_id: string;
      item_type: string;
      item_id: string;
      x: string | number;
      y: string | number;
      metadata_title: string | null;
    }>>`
      SELECT
        r.board_item_id,
        bi.item_type,
        bi.item_id,
        bi.x,
        bi.y,
        bi.metadata->>'title' AS metadata_title
      FROM tasks r
      JOIN board_items bi ON bi.id = r.board_item_id
      WHERE r.id = 'rb-1'
    `;

    expect(result.snapshot.task.board_item_id).toBe("task:rb-1");
    expect(rows[0]).toMatchObject({
      board_item_id: "task:rb-1",
      item_type: "task",
      item_id: "rb-1",
      metadata_title: "Task",
    });
    expect(Number(rows[0]?.x)).toBe(120);
    expect(Number(rows[0]?.y)).toBe(240);
  });

  it("creates browser-owned tasks with user audit and no fabricated session event", async () => {
    const result = await service.createTask({
      taskId: "rb-browser",
      folderId: "folder-1",
      title: "Browser Task",
      actorKind: "user",
      actorSessionId: null,
      actorUserId: "operator@example.com",
      enrollCreator: false,
    });

    const operation = await harness!.sql<Array<{
      actor_kind: string;
      actor_session_id: string | null;
      actor_event_id: number | null;
      actor_user_id: string | null;
    }>>`
      SELECT actor_kind, actor_session_id, actor_event_id, actor_user_id
      FROM task_operations
      WHERE task_id = 'rb-browser'
    `;

    expect(result.snapshot.task.created_session_id).toBeNull();
    expect(result.snapshot.task.created_event_id).toBeNull();
    expect(operation[0]).toEqual({
      actor_kind: "user",
      actor_session_id: null,
      actor_event_id: null,
      actor_user_id: "operator@example.com",
    });
    expect(emitTaskUpdated).not.toHaveBeenCalled();
  });

  it("keeps a task board item when later board Yjs changes persist", async () => {
    await service.createTask({
      taskId: "rb-1",
      folderId: "folder-1",
      title: "Task",
      x: 120,
      y: 240,
      actorSessionId: "sess-actor",
    });

    await boardYjsService!.createMarkdownDocument({
      folderId: "folder-1",
      documentId: "doc-1",
      title: "Note",
      body: "Body",
      x: 280,
      y: 0,
    });

    const rows = await harness!.sql<Array<{
      task_count: string | number;
      board_item_count: string | number;
      markdown_count: string | number;
    }>>`
      SELECT
        (SELECT COUNT(*) FROM tasks WHERE id = 'rb-1') AS task_count,
        (SELECT COUNT(*) FROM board_items WHERE id = 'task:rb-1') AS board_item_count,
        (SELECT COUNT(*) FROM board_items WHERE id = 'markdown:doc-1') AS markdown_count
    `;

    expect(Number(rows[0]?.task_count)).toBe(1);
    expect(Number(rows[0]?.board_item_count)).toBe(1);
    expect(Number(rows[0]?.markdown_count)).toBe(1);
  });

  it("lists tasks within a folder and filters archived rows by default", async () => {
    await service.createTask({
      taskId: "rb-visible",
      folderId: "folder-1",
      title: "Visible",
      x: 40,
      y: 80,
      actorSessionId: "sess-actor",
    });
    await service.createTask({
      taskId: "rb-archived",
      folderId: "folder-1",
      title: "Archived",
      x: 20,
      y: 20,
      actorSessionId: "sess-actor",
    });
    await service.patchTask({
      taskId: "rb-archived",
      expectedVersion: 1,
      archived: true,
      actorSessionId: "sess-actor",
    });
    await harness!.sql`INSERT INTO folders (id, name, sort_order) VALUES ('folder-2', 'Other', 2)`;
    await service.createTask({
      taskId: "rb-other",
      folderId: "folder-2",
      title: "Other",
      actorSessionId: "sess-actor",
    });

    await expect(service.listTasks({ folderId: "folder-1" })).resolves.toMatchObject([
      { id: "rb-visible", folder_id: "folder-1", title: "Visible", archived: false },
    ]);
    await expect(service.listTasks({
      folderId: "folder-1",
      includeArchived: true,
    })).resolves.toMatchObject([
      { id: "rb-archived", archived: true },
      { id: "rb-visible", archived: false },
    ]);
  });

  it("records archive and unarchive as symmetric task operations", async () => {
    await seedTask();

    const archived = await service.patchTask({
      taskId: "rb-1",
      expectedVersion: 1,
      archived: true,
      actorSessionId: "sess-actor",
      idempotencyKey: "task:rb-1:archive",
    });
    const restored = await service.patchTask({
      taskId: "rb-1",
      expectedVersion: 2,
      archived: false,
      actorSessionId: "sess-actor",
      idempotencyKey: "task:rb-1:unarchive",
    });

    expect(archived.operation.operation_type).toBe("archive_task");
    expect(restored.operation.operation_type).toBe("unarchive_task");
    expect(restored.snapshot.task.archived).toBe(false);
  });

  it("records user task completion attribution and replays duplicate status idempotency keys", async () => {
    await seedTaskWithItem();
    emitTaskUpdated.mockClear();

    const first = await service.setTaskStatus({
      taskId: "rb-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      idempotencyKey: "task:rb-1:status:completed:v1:user",
    });
    const second = await service.setTaskStatus({
      taskId: "rb-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      idempotencyKey: "task:rb-1:status:completed:v1:user",
    });

    const rows = await harness!.sql<Array<{
      status: string;
      completed_kind: string | null;
      completed_session_id: string | null;
      completed_event_id: number | null;
      completed_user_id: string | null;
      operation_count: string | number;
    }>>`
      SELECT
        r.status,
        r.completed_kind,
        r.completed_session_id,
        r.completed_event_id,
        r.completed_user_id,
        (
          SELECT COUNT(*)
          FROM task_operations
          WHERE operation_type = 'set_task_status'
        ) AS operation_count
      FROM tasks r
      WHERE r.id = 'rb-1'
    `;

    expect(first.operation.operation_type).toBe("set_task_status");
    expect(first.snapshot.task).toMatchObject({ status: "completed", version: 2 });
    expect(second.idempotent).toBe(true);
    expect(second.operation.id).toBe(first.operation.id);
    expect(second.eventId).toBe(first.eventId);
    expect(rows[0]).toMatchObject({
      status: "completed",
      completed_kind: "user",
      completed_session_id: "sess-actor",
      completed_event_id: expect.any(Number),
      completed_user_id: "operator@example.com",
    });
    expect(Number(rows[0]?.operation_count)).toBe(1);
    expect(emitTaskUpdated).toHaveBeenCalledTimes(1);
  });

  it("reopens a completed task and clears completion provenance", async () => {
    await seedTask();

    await service.setTaskStatus({
      taskId: "rb-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "agent",
      actorSessionId: "sess-actor",
    });
    const reopened = await service.setTaskStatus({
      taskId: "rb-1",
      expectedVersion: 2,
      status: "open",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      reason: "more work",
    });

    expect(reopened.operation).toMatchObject({
      operation_type: "set_task_status",
      reason: "more work",
    });
    expect(reopened.snapshot.task).toMatchObject({
      status: "open",
      version: 3,
      completed_kind: null,
      completed_session_id: null,
      completed_event_id: null,
      completed_user_id: null,
      completed_at: null,
    });
  });

  it("does not notify handoff when a user completes a task", async () => {
    await seedTask();

    await service.setTaskStatus({
      taskId: "rb-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
    });

    expect(notifyHumanHandoff).not.toHaveBeenCalled();
  });

  it("does not notify handoff for agent task status changes", async () => {
    await seedTask();

    await service.setTaskStatus({
      taskId: "rb-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "agent",
      actorSessionId: "sess-actor",
    });

    expect(notifyHumanHandoff).not.toHaveBeenCalled();
  });

  it("raises a 409-style TaskVersionConflict before recording an event", async () => {
    await seedTask();
    await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-1",
      title: "Spec",
      actorSessionId: "sess-actor",
    });

    await expect(
      service.patchSection({
        taskId: "rb-1",
        sectionId: "sec-1",
        expectedVersion: 0,
        title: "Stale",
        actorSessionId: "sess-actor",
      }),
    ).rejects.toMatchObject({
      name: "TaskVersionConflict",
      statusCode: 409,
    } satisfies Partial<TaskVersionConflict>);

    const operations = await db.tasks().listOperations("rb-1");
    expect(operations.map((op) => op.operation_type)).toEqual([
      "create_task_section",
      "create_task",
    ]);
  });

  it("returns the existing operation and snapshot for duplicate idempotency keys", async () => {
    await seedTask();

    const first = await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-idem",
      title: "Original",
      actorSessionId: "sess-actor",
      idempotencyKey: "task:rb-1:section:create:idem",
    });
    const second = await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-other",
      title: "Different",
      actorSessionId: "sess-actor",
      idempotencyKey: "task:rb-1:section:create:idem",
    });

    expect(second.idempotent).toBe(true);
    expect(second.operation.id).toBe(first.operation.id);
    expect(second.eventId).toBe(first.eventId);
    expect(second.snapshot.sections.map((section) => section.title)).toEqual([
      "Original",
    ]);
  });

  it("emits task_updated after a committed mutation and skips idempotent replay", async () => {
    await seedTask();
    emitTaskUpdated.mockClear();
    observedOperationCounts.length = 0;

    await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-broadcast",
      title: "Broadcast",
      actorSessionId: "sess-actor",
      idempotencyKey: "task:rb-1:section:create:broadcast",
    });
    await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-broadcast-retry",
      title: "Retry",
      actorSessionId: "sess-actor",
      idempotencyKey: "task:rb-1:section:create:broadcast",
    });

    expect(emitTaskUpdated).toHaveBeenCalledTimes(1);
    expect(emitTaskUpdated).toHaveBeenCalledWith(
      "sess-actor",
      "rb-1",
      "task:rb-1",
    );
    expect(observedOperationCounts).toEqual([2]);
  });

  it("rejects mismatched task ownership before recording an operation", async () => {
    await seedTask();
    await service.createTask({
      taskId: "rb-2",
      folderId: "folder-1",
      title: "Other",
      actorSessionId: "sess-actor",
    });
    await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-1",
      title: "Spec",
      actorSessionId: "sess-actor",
    });

    await expect(
      service.createItem({
        taskId: "rb-2",
        sectionId: "sec-1",
        title: "Wrong task",
        actorSessionId: "sess-actor",
      }),
    ).rejects.toThrow("assertSectionBelongsToTaskTx");

    expect((await db.tasks().listOperations("rb-2")).map((op) => op.operation_type)).toEqual([
      "create_task",
    ]);
  });

  it("writes non-null event ids into row provenance and operation provenance", async () => {
    await seedTask();
    await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-1",
      title: "Spec",
      actorSessionId: "sess-actor",
    });
    await service.createItem({
      taskId: "rb-1",
      sectionId: "sec-1",
      itemId: "item-1",
      title: "Deploy",
      actorSessionId: "sess-actor",
    });
    await service.setItemStatus({
      itemId: "item-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "agent",
      actorSessionId: "sess-actor",
    });

    const rows = await harness!.sql<Array<{
      section_created: number | null;
      section_updated: number | null;
      item_created: number | null;
      item_updated: number | null;
      completed_event: number | null;
      op_null_count: string | number;
      joined_op_count: string | number;
    }>>`
      SELECT
        s.created_event_id AS section_created,
        s.updated_event_id AS section_updated,
        i.created_event_id AS item_created,
        i.updated_event_id AS item_updated,
        i.completed_event_id AS completed_event,
        (SELECT COUNT(*) FROM task_operations WHERE actor_event_id IS NULL) AS op_null_count,
        (
          SELECT COUNT(*)
          FROM task_operations ro
          JOIN events e ON e.session_id = ro.actor_session_id AND e.id = ro.actor_event_id
        ) AS joined_op_count
      FROM task_sections s
      JOIN task_items i ON i.section_id = s.id
      WHERE s.id = 'sec-1' AND i.id = 'item-1'
    `;

    expect(rows[0]).toMatchObject({
      section_created: expect.any(Number),
      section_updated: expect.any(Number),
      item_created: expect.any(Number),
      item_updated: expect.any(Number),
      completed_event: expect.any(Number),
    });
    expect(Number(rows[0]?.op_null_count)).toBe(0);
    expect(Number(rows[0]?.joined_op_count)).toBe(4);
  });

  it("assigns fractional item positions between neighbors", async () => {
    await seedTask();
    await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-1",
      title: "Spec",
      actorSessionId: "sess-actor",
    });
    await service.createItem({
      taskId: "rb-1",
      sectionId: "sec-1",
      itemId: "item-a",
      title: "A",
      actorSessionId: "sess-actor",
    });
    await service.createItem({
      taskId: "rb-1",
      sectionId: "sec-1",
      itemId: "item-c",
      title: "C",
      actorSessionId: "sess-actor",
    });
    const result = await service.createItem({
      taskId: "rb-1",
      sectionId: "sec-1",
      itemId: "item-b",
      title: "B",
      actorSessionId: "sess-actor",
      afterItemId: "item-a",
      beforeItemId: "item-c",
    });

    const ordered = result.snapshot.items
      .slice()
      .sort((a, b) => (a.position_key < b.position_key ? -1 : a.position_key > b.position_key ? 1 : 0));
    expect(ordered.map((item) => item.title)).toEqual(["A", "B", "C"]);
    expect(ordered[0]!.position_key < ordered[1]!.position_key).toBe(true);
    expect(ordered[1]!.position_key < ordered[2]!.position_key).toBe(true);
  });

  it("moves items across sections with CAS and records move_task_item", async () => {
    await seedTask();
    await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-a",
      title: "A",
      actorSessionId: "sess-actor",
    });
    await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-b",
      title: "B",
      actorSessionId: "sess-actor",
    });
    await service.createItem({
      taskId: "rb-1",
      sectionId: "sec-a",
      itemId: "item-move",
      title: "Move me",
      actorSessionId: "sess-actor",
    });

    const result = await service.moveItem({
      taskId: "rb-1",
      itemId: "item-move",
      expectedVersion: 1,
      sectionId: "sec-b",
      actorSessionId: "sess-actor",
      idempotencyKey: "task:rb-1:item:move:item-move",
    });

    expect(result.operation.operation_type).toBe("move_task_item");
    expect(result.snapshot.items.find((item) => item.id === "item-move")).toMatchObject({
      section_id: "sec-b",
      version: 2,
    });
  });

  it("records cancelled as a semantic status without completion provenance", async () => {
    await seedTaskWithItem();

    const result = await service.setItemStatus({
      itemId: "item-1",
      expectedVersion: 1,
      status: "cancelled",
      reason: "not needed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "user-1",
    });

    const item = result.snapshot.items.find((candidate) => candidate.id === "item-1");
    expect(item).toMatchObject({
      status: "cancelled",
      completed_kind: null,
      completed_event_id: null,
      completed_user_id: null,
    });
    expect(result.operation).toMatchObject({
      operation_type: "set_item_status",
      reason: "not needed",
    });
  });

  it("records review as a non-terminal status without completion provenance or handoff", async () => {
    await seedTaskWithItem();

    const result = await service.setItemStatus({
      itemId: "item-1",
      expectedVersion: 1,
      status: "review",
      reason: "ready for human review",
      actorKind: "agent",
      actorSessionId: "sess-actor",
    });

    const item = result.snapshot.items.find((candidate) => candidate.id === "item-1");
    expect(item).toMatchObject({
      status: "review",
      version: 2,
      completed_kind: null,
      completed_event_id: null,
      completed_user_id: null,
    });
    expect(result.operation).toMatchObject({
      operation_type: "set_item_status",
      payload_json: { status: "review" },
      reason: "ready for human review",
    });
    expect(notifyHumanHandoff).not.toHaveBeenCalled();
  });

  it("records user completion attribution and replays duplicate status idempotency keys", async () => {
    await seedTaskWithItem();
    emitTaskUpdated.mockClear();

    const first = await service.setItemStatus({
      itemId: "item-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      idempotencyKey: "task:rb-1:item:item-1:status:completed:v1:user",
    });
    const second = await service.setItemStatus({
      itemId: "item-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      idempotencyKey: "task:rb-1:item:item-1:status:completed:v1:user",
    });

    const rows = await harness!.sql<Array<{
      status: string;
      completed_kind: string | null;
      completed_session_id: string | null;
      completed_event_id: number | null;
      completed_user_id: string | null;
      operation_count: string | number;
    }>>`
      SELECT
        i.status,
        i.completed_kind,
        i.completed_session_id,
        i.completed_event_id,
        i.completed_user_id,
        (
          SELECT COUNT(*)
          FROM task_operations
          WHERE operation_type = 'set_item_status'
        ) AS operation_count
      FROM task_items i
      WHERE i.id = 'item-1'
    `;

    expect(first.operation.operation_type).toBe("set_item_status");
    expect(second.idempotent).toBe(true);
    expect(second.operation.id).toBe(first.operation.id);
    expect(second.eventId).toBe(first.eventId);
    expect(rows[0]).toMatchObject({
      status: "completed",
      completed_kind: "user",
      completed_session_id: "sess-actor",
      completed_event_id: expect.any(Number),
      completed_user_id: "operator@example.com",
    });
    expect(Number(rows[0]?.operation_count)).toBe(1);
    expect(emitTaskUpdated).toHaveBeenCalledTimes(1);
  });

  it("notifies handoff only when a user moves an item to a terminal status", async () => {
    await seedTaskWithItem();

    await service.setItemStatus({
      itemId: "item-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
    });

    expect(notifyHumanHandoff).toHaveBeenCalledTimes(1);
    expect(notifyHumanHandoff).toHaveBeenCalledWith({
      taskId: "rb-1",
      taskTitle: "Task",
      boardItemId: "task:rb-1",
      itemId: "item-1",
      itemTitle: "Deploy",
      status: "completed",
      operationId: expect.any(String),
      eventId: expect.any(Number),
    });
  });

  it("sends handoff messages through the derived subscriber list after user completion", async () => {
    await seedTaskWithItem();
    const sender = {
      send: vi.fn(async () => ({ ok: true, detail: { queued: true } })),
    };
    const serviceWithNotifier = new TaskService(
      db,
      { emitTaskUpdated },
      boardYjsService!,
      new TaskHandoffNotifier(
        db.tasks(),
        sender as never,
        createSilentLogger() as never,
      ),
    );

    await serviceWithNotifier.setItemStatus({
      itemId: "item-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
    });
    await waitForMockCall(sender.send);

    expect(sender.send).toHaveBeenCalledWith({
      targetSessionId: "sess-actor",
      message: expect.stringContaining("업무 'Task'의 'Deploy' 완료됨, 이어서 진행"),
    });
  });

  it("does not fail the status mutation when handoff delivery fails", async () => {
    await seedTaskWithItem();
    const sender = {
      send: vi.fn(async () => {
        throw new Error("delivery failed");
      }),
    };
    const serviceWithNotifier = new TaskService(
      db,
      { emitTaskUpdated },
      boardYjsService!,
      new TaskHandoffNotifier(
        db.tasks(),
        sender as never,
        createSilentLogger() as never,
      ),
    );

    const result = await serviceWithNotifier.setItemStatus({
      itemId: "item-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
    });
    await waitForMockCall(sender.send);

    expect(result.snapshot.items.find((item) => item.id === "item-1")).toMatchObject({
      status: "completed",
      version: 2,
    });
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it("does not notify handoff for agent item status changes", async () => {
    await seedTaskWithItem();

    await service.setItemStatus({
      itemId: "item-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "agent",
      actorSessionId: "sess-actor",
    });

    expect(notifyHumanHandoff).not.toHaveBeenCalled();
  });

  it("derives distinct agent subscribers from task operation provenance", async () => {
    await seedTaskWithItem();
    await harness!.sql`
      INSERT INTO sessions (session_id, node_id, status, session_type)
      VALUES ('sess-agent-2', 'node-1', 'completed', 'claude')
    `;
    await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-agent-2",
      title: "Second agent",
      actorKind: "agent",
      actorSessionId: "sess-agent-2",
    });
    await service.setItemStatus({
      itemId: "item-1",
      expectedVersion: 1,
      status: "cancelled",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
    });

    await expect(db.tasks().listAgentSubscriberSessionIds("rb-1")).resolves.toEqual([
      "sess-actor",
      "sess-agent-2",
    ]);
  });

  it("derives human-turn items through item own assignee or section inheritance", async () => {
    await seedTask();
    await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-human",
      title: "Human section",
      actorSessionId: "sess-actor",
      assignee: { kind: "human", userId: "user-1" },
    });
    await service.createItem({
      taskId: "rb-1",
      sectionId: "sec-human",
      itemId: "item-inherited",
      title: "Inherited",
      actorSessionId: "sess-actor",
    });

    expect((await service.listMyTurnItems({ userId: "user-1" })).map((row) => row.item_id)).toEqual([
      "item-inherited",
    ]);

    const reassigned = await service.setItemAssignee({
      taskId: "rb-1",
      itemId: "item-inherited",
      expectedVersion: 1,
      actorSessionId: "sess-actor",
      assignee: { kind: "agent", agentId: "agent-1" },
    });

    expect(reassigned.operation.operation_type).toBe("set_task_item_assignee");
    expect(await service.listMyTurnItems({ userId: "user-1" })).toEqual([]);
  });

  it("includes review items in my-turn regardless of effective assignee", async () => {
    await seedTask();
    await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-agent",
      title: "Agent section",
      actorSessionId: "sess-actor",
      assignee: { kind: "agent", agentId: "roselin_codex" },
    });
    await service.createItem({
      taskId: "rb-1",
      sectionId: "sec-agent",
      itemId: "item-review",
      title: "Ready for review",
      actorSessionId: "sess-actor",
    });
    await service.setItemStatus({
      itemId: "item-review",
      expectedVersion: 1,
      status: "review",
      actorKind: "agent",
      actorSessionId: "sess-actor",
    });

    const rows = await service.listMyTurnItems({ userId: "user-1" });
    expect(rows).toMatchObject([
      {
        item_id: "item-review",
        status: "review",
        effective_assignee_kind: "agent",
        effective_assignee_agent_id: "roselin_codex",
      },
    ]);
  });

  it("excludes completed tasks from my-turn items while leaving the task readable", async () => {
    await seedTask();
    await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-human",
      title: "Human section",
      actorSessionId: "sess-actor",
      assignee: { kind: "human", userId: "user-1" },
    });
    await service.createItem({
      taskId: "rb-1",
      sectionId: "sec-human",
      itemId: "item-human",
      title: "Human task",
      actorSessionId: "sess-actor",
    });

    expect((await service.listMyTurnItems({ userId: "user-1" })).map((row) => row.item_id)).toEqual([
      "item-human",
    ]);

    const completed = await service.setTaskStatus({
      taskId: "rb-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
    });

    expect(completed.snapshot.task.status).toBe("completed");
    expect(await service.listMyTurnItems({ userId: "user-1" })).toEqual([]);
    await expect(service.getTask("rb-1")).resolves.toMatchObject({
      task: { status: "completed" },
    });
  });

  it("sets and clears section assignee through a first-class operation", async () => {
    await seedTask();
    await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-assign",
      title: "Assign",
      actorSessionId: "sess-actor",
    });

    const assigned = await service.setSectionAssignee({
      taskId: "rb-1",
      sectionId: "sec-assign",
      expectedVersion: 1,
      actorSessionId: "sess-actor",
      assignee: { kind: "session", sessionId: "sess-actor" },
      idempotencyKey: "task:rb-1:section:sec-assign:assignee:sess",
    });
    const cleared = await service.setSectionAssignee({
      taskId: "rb-1",
      sectionId: "sec-assign",
      expectedVersion: 2,
      actorSessionId: "sess-actor",
      assignee: null,
      idempotencyKey: "task:rb-1:section:sec-assign:assignee:null",
    });

    expect(assigned.operation.operation_type).toBe("set_task_section_assignee");
    expect(cleared.snapshot.sections.find((section) => section.id === "sec-assign")).toMatchObject({
      assignee_kind: null,
      assignee_session_id: null,
      version: 3,
    });
  });

  async function seedTask(): Promise<void> {
    await service.createTask({
      taskId: "rb-1",
      folderId: "folder-1",
      title: "Task",
      actorSessionId: "sess-actor",
    });
  }

  async function seedTaskWithItem(): Promise<void> {
    await seedTask();
    await service.createSection({
      taskId: "rb-1",
      sectionId: "sec-1",
      title: "Spec",
      actorSessionId: "sess-actor",
    });
    await service.createItem({
      taskId: "rb-1",
      sectionId: "sec-1",
      itemId: "item-1",
      title: "Deploy",
      actorSessionId: "sess-actor",
    });
  }
});

function createSilentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => createSilentLogger(),
  };
}

function createTestBoardYjsService(db: SessionDB): BoardYjsService {
  return new BoardYjsService({
    db,
    logger: createSilentLogger() as never,
    nodeId: "test-node",
    hostNodeId: "test-node",
    isHost: true,
    auth: {
      authBearerToken: "",
      environment: "development",
      dashboardAuthEnabled: false,
    },
  });
}

async function waitForMockCall(mock: ReturnType<typeof vi.fn>): Promise<void> {
  const startedAt = Date.now();
  while (mock.mock.calls.length === 0 && Date.now() - startedAt < 500) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

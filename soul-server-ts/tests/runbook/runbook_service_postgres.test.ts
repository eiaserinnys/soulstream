import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
import { RunbookHandoffNotifier } from "../../src/runbook/runbook_handoff_notifier.js";
import { RunbookVersionConflict } from "../../src/runbook/runbook_models.js";
import { RunbookService } from "../../src/runbook/runbook_service.js";
import {
  createRunbookPostgresHarness,
  hasRunbookPostgresBackend,
  resetRunbookData,
  type RunbookPostgresHarness,
} from "./runbook_postgres_harness.js";

const hasPostgresTestBackend = hasRunbookPostgresBackend;
const describePostgres = hasPostgresTestBackend ? describe : describe.skip;

describePostgres("RunbookService PostgreSQL integration", () => {
  let harness: RunbookPostgresHarness | undefined;
  let db: SessionDB;
  let service: RunbookService;
  let emitRunbookUpdated: ReturnType<typeof vi.fn>;
  let notifyHumanHandoff: ReturnType<typeof vi.fn>;
  const observedOperationCounts: number[] = [];

  beforeAll(async () => {
    harness = await createRunbookPostgresHarness();
    db = new SessionDB(harness.sql);
    emitRunbookUpdated = vi.fn(async (actorSessionId: string, runbookId: string) => {
      if (actorSessionId === "sess-actor") {
        observedOperationCounts.push(
          (await db.runbooks().listOperations(runbookId)).length,
        );
      }
    });
    notifyHumanHandoff = vi.fn();
    service = new RunbookService(db, { emitRunbookUpdated }, { notifyHumanHandoff });
  }, 45_000);

  beforeEach(async () => {
    if (!harness) return;
    await resetRunbookData(harness.sql);
    emitRunbookUpdated.mockClear();
    notifyHumanHandoff.mockClear();
    observedOperationCounts.length = 0;
  }, 15_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 15_000);

  it("creates a first-class runbook board item and links it 1:1", async () => {
    const result = await service.createRunbook({
      runbookId: "rb-1",
      folderId: "folder-1",
      title: "Runbook",
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
      FROM runbooks r
      JOIN board_items bi ON bi.id = r.board_item_id
      WHERE r.id = 'rb-1'
    `;

    expect(result.snapshot.runbook.board_item_id).toBe("runbook:rb-1");
    expect(rows[0]).toMatchObject({
      board_item_id: "runbook:rb-1",
      item_type: "runbook",
      item_id: "rb-1",
      metadata_title: "Runbook",
    });
    expect(Number(rows[0]?.x)).toBe(120);
    expect(Number(rows[0]?.y)).toBe(240);
  });

  it("lists runbooks within a folder and filters archived rows by default", async () => {
    await service.createRunbook({
      runbookId: "rb-visible",
      folderId: "folder-1",
      title: "Visible",
      x: 40,
      y: 80,
      actorSessionId: "sess-actor",
    });
    await service.createRunbook({
      runbookId: "rb-archived",
      folderId: "folder-1",
      title: "Archived",
      x: 20,
      y: 20,
      actorSessionId: "sess-actor",
    });
    await service.patchRunbook({
      runbookId: "rb-archived",
      expectedVersion: 1,
      archived: true,
      actorSessionId: "sess-actor",
    });
    await harness!.sql`INSERT INTO folders (id, name, sort_order) VALUES ('folder-2', 'Other', 2)`;
    await service.createRunbook({
      runbookId: "rb-other",
      folderId: "folder-2",
      title: "Other",
      actorSessionId: "sess-actor",
    });

    await expect(service.listRunbooks({ folderId: "folder-1" })).resolves.toMatchObject([
      { id: "rb-visible", folder_id: "folder-1", title: "Visible", archived: false },
    ]);
    await expect(service.listRunbooks({
      folderId: "folder-1",
      includeArchived: true,
    })).resolves.toMatchObject([
      { id: "rb-archived", archived: true },
      { id: "rb-visible", archived: false },
    ]);
  });

  it("records archive and unarchive as symmetric runbook operations", async () => {
    await seedRunbook();

    const archived = await service.patchRunbook({
      runbookId: "rb-1",
      expectedVersion: 1,
      archived: true,
      actorSessionId: "sess-actor",
      idempotencyKey: "runbook:rb-1:archive",
    });
    const restored = await service.patchRunbook({
      runbookId: "rb-1",
      expectedVersion: 2,
      archived: false,
      actorSessionId: "sess-actor",
      idempotencyKey: "runbook:rb-1:unarchive",
    });

    expect(archived.operation.operation_type).toBe("archive_runbook");
    expect(restored.operation.operation_type).toBe("unarchive_runbook");
    expect(restored.snapshot.runbook.archived).toBe(false);
  });

  it("records user runbook completion attribution and replays duplicate status idempotency keys", async () => {
    await seedRunbookWithItem();
    emitRunbookUpdated.mockClear();

    const first = await service.setRunbookStatus({
      runbookId: "rb-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      idempotencyKey: "runbook:rb-1:status:completed:v1:user",
    });
    const second = await service.setRunbookStatus({
      runbookId: "rb-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      idempotencyKey: "runbook:rb-1:status:completed:v1:user",
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
          FROM runbook_operations
          WHERE operation_type = 'set_runbook_status'
        ) AS operation_count
      FROM runbooks r
      WHERE r.id = 'rb-1'
    `;

    expect(first.operation.operation_type).toBe("set_runbook_status");
    expect(first.snapshot.runbook).toMatchObject({ status: "completed", version: 2 });
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
    expect(emitRunbookUpdated).toHaveBeenCalledTimes(1);
  });

  it("reopens a completed runbook and clears completion provenance", async () => {
    await seedRunbook();

    await service.setRunbookStatus({
      runbookId: "rb-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "agent",
      actorSessionId: "sess-actor",
    });
    const reopened = await service.setRunbookStatus({
      runbookId: "rb-1",
      expectedVersion: 2,
      status: "open",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      reason: "more work",
    });

    expect(reopened.operation).toMatchObject({
      operation_type: "set_runbook_status",
      reason: "more work",
    });
    expect(reopened.snapshot.runbook).toMatchObject({
      status: "open",
      version: 3,
      completed_kind: null,
      completed_session_id: null,
      completed_event_id: null,
      completed_user_id: null,
      completed_at: null,
    });
  });

  it("notifies handoff when a user completes a runbook", async () => {
    await seedRunbook();

    await service.setRunbookStatus({
      runbookId: "rb-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
    });

    expect(notifyHumanHandoff).toHaveBeenCalledTimes(1);
    expect(notifyHumanHandoff).toHaveBeenCalledWith({
      runbookId: "rb-1",
      runbookTitle: "Runbook",
      boardItemId: "runbook:rb-1",
      status: "completed",
      operationId: expect.any(String),
      eventId: expect.any(Number),
    });
  });

  it("does not notify handoff for agent runbook status changes", async () => {
    await seedRunbook();

    await service.setRunbookStatus({
      runbookId: "rb-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "agent",
      actorSessionId: "sess-actor",
    });

    expect(notifyHumanHandoff).not.toHaveBeenCalled();
  });

  it("raises a 409-style RunbookVersionConflict before recording an event", async () => {
    await seedRunbook();
    await service.createSection({
      runbookId: "rb-1",
      sectionId: "sec-1",
      title: "Spec",
      actorSessionId: "sess-actor",
    });

    await expect(
      service.patchSection({
        runbookId: "rb-1",
        sectionId: "sec-1",
        expectedVersion: 0,
        title: "Stale",
        actorSessionId: "sess-actor",
      }),
    ).rejects.toMatchObject({
      name: "RunbookVersionConflict",
      statusCode: 409,
    } satisfies Partial<RunbookVersionConflict>);

    const operations = await db.runbooks().listOperations("rb-1");
    expect(operations.map((op) => op.operation_type)).toEqual([
      "create_runbook_section",
      "create_runbook",
    ]);
  });

  it("returns the existing operation and snapshot for duplicate idempotency keys", async () => {
    await seedRunbook();

    const first = await service.createSection({
      runbookId: "rb-1",
      sectionId: "sec-idem",
      title: "Original",
      actorSessionId: "sess-actor",
      idempotencyKey: "runbook:rb-1:section:create:idem",
    });
    const second = await service.createSection({
      runbookId: "rb-1",
      sectionId: "sec-other",
      title: "Different",
      actorSessionId: "sess-actor",
      idempotencyKey: "runbook:rb-1:section:create:idem",
    });

    expect(second.idempotent).toBe(true);
    expect(second.operation.id).toBe(first.operation.id);
    expect(second.eventId).toBe(first.eventId);
    expect(second.snapshot.sections.map((section) => section.title)).toEqual([
      "Original",
    ]);
  });

  it("emits runbook_updated after a committed mutation and skips idempotent replay", async () => {
    await seedRunbook();
    emitRunbookUpdated.mockClear();
    observedOperationCounts.length = 0;

    await service.createSection({
      runbookId: "rb-1",
      sectionId: "sec-broadcast",
      title: "Broadcast",
      actorSessionId: "sess-actor",
      idempotencyKey: "runbook:rb-1:section:create:broadcast",
    });
    await service.createSection({
      runbookId: "rb-1",
      sectionId: "sec-broadcast-retry",
      title: "Retry",
      actorSessionId: "sess-actor",
      idempotencyKey: "runbook:rb-1:section:create:broadcast",
    });

    expect(emitRunbookUpdated).toHaveBeenCalledTimes(1);
    expect(emitRunbookUpdated).toHaveBeenCalledWith(
      "sess-actor",
      "rb-1",
      "runbook:rb-1",
    );
    expect(observedOperationCounts).toEqual([2]);
  });

  it("rejects mismatched runbook ownership before recording an operation", async () => {
    await seedRunbook();
    await service.createRunbook({
      runbookId: "rb-2",
      folderId: "folder-1",
      title: "Other",
      actorSessionId: "sess-actor",
    });
    await service.createSection({
      runbookId: "rb-1",
      sectionId: "sec-1",
      title: "Spec",
      actorSessionId: "sess-actor",
    });

    await expect(
      service.createItem({
        runbookId: "rb-2",
        sectionId: "sec-1",
        title: "Wrong runbook",
        actorSessionId: "sess-actor",
      }),
    ).rejects.toThrow("assertSectionBelongsToRunbookTx");

    expect((await db.runbooks().listOperations("rb-2")).map((op) => op.operation_type)).toEqual([
      "create_runbook",
    ]);
  });

  it("writes non-null event ids into row provenance and operation provenance", async () => {
    await seedRunbook();
    await service.createSection({
      runbookId: "rb-1",
      sectionId: "sec-1",
      title: "Spec",
      actorSessionId: "sess-actor",
    });
    await service.createItem({
      runbookId: "rb-1",
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
        (SELECT COUNT(*) FROM runbook_operations WHERE actor_event_id IS NULL) AS op_null_count,
        (
          SELECT COUNT(*)
          FROM runbook_operations ro
          JOIN events e ON e.session_id = ro.actor_session_id AND e.id = ro.actor_event_id
        ) AS joined_op_count
      FROM runbook_sections s
      JOIN runbook_items i ON i.section_id = s.id
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
    await seedRunbook();
    await service.createSection({
      runbookId: "rb-1",
      sectionId: "sec-1",
      title: "Spec",
      actorSessionId: "sess-actor",
    });
    await service.createItem({
      runbookId: "rb-1",
      sectionId: "sec-1",
      itemId: "item-a",
      title: "A",
      actorSessionId: "sess-actor",
    });
    await service.createItem({
      runbookId: "rb-1",
      sectionId: "sec-1",
      itemId: "item-c",
      title: "C",
      actorSessionId: "sess-actor",
    });
    const result = await service.createItem({
      runbookId: "rb-1",
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

  it("moves items across sections with CAS and records move_runbook_item", async () => {
    await seedRunbook();
    await service.createSection({
      runbookId: "rb-1",
      sectionId: "sec-a",
      title: "A",
      actorSessionId: "sess-actor",
    });
    await service.createSection({
      runbookId: "rb-1",
      sectionId: "sec-b",
      title: "B",
      actorSessionId: "sess-actor",
    });
    await service.createItem({
      runbookId: "rb-1",
      sectionId: "sec-a",
      itemId: "item-move",
      title: "Move me",
      actorSessionId: "sess-actor",
    });

    const result = await service.moveItem({
      runbookId: "rb-1",
      itemId: "item-move",
      expectedVersion: 1,
      sectionId: "sec-b",
      actorSessionId: "sess-actor",
      idempotencyKey: "runbook:rb-1:item:move:item-move",
    });

    expect(result.operation.operation_type).toBe("move_runbook_item");
    expect(result.snapshot.items.find((item) => item.id === "item-move")).toMatchObject({
      section_id: "sec-b",
      version: 2,
    });
  });

  it("records cancelled as a semantic status without completion provenance", async () => {
    await seedRunbookWithItem();

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

  it("records user completion attribution and replays duplicate status idempotency keys", async () => {
    await seedRunbookWithItem();
    emitRunbookUpdated.mockClear();

    const first = await service.setItemStatus({
      itemId: "item-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      idempotencyKey: "runbook:rb-1:item:item-1:status:completed:v1:user",
    });
    const second = await service.setItemStatus({
      itemId: "item-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
      idempotencyKey: "runbook:rb-1:item:item-1:status:completed:v1:user",
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
          FROM runbook_operations
          WHERE operation_type = 'set_item_status'
        ) AS operation_count
      FROM runbook_items i
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
    expect(emitRunbookUpdated).toHaveBeenCalledTimes(1);
  });

  it("notifies handoff only when a user moves an item to a terminal status", async () => {
    await seedRunbookWithItem();

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
      runbookId: "rb-1",
      runbookTitle: "Runbook",
      boardItemId: "runbook:rb-1",
      itemId: "item-1",
      itemTitle: "Deploy",
      status: "completed",
      operationId: expect.any(String),
      eventId: expect.any(Number),
    });
  });

  it("sends handoff messages through the derived subscriber list after user completion", async () => {
    await seedRunbookWithItem();
    const sender = {
      send: vi.fn(async () => ({ ok: true, detail: { queued: true } })),
    };
    const serviceWithNotifier = new RunbookService(
      db,
      { emitRunbookUpdated },
      new RunbookHandoffNotifier(
        db.runbooks(),
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
      message: expect.stringContaining("런북 'Runbook'의 'Deploy' 완료됨, 이어서 진행"),
    });
  });

  it("does not fail the status mutation when handoff delivery fails", async () => {
    await seedRunbookWithItem();
    const sender = {
      send: vi.fn(async () => {
        throw new Error("delivery failed");
      }),
    };
    const serviceWithNotifier = new RunbookService(
      db,
      { emitRunbookUpdated },
      new RunbookHandoffNotifier(
        db.runbooks(),
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
    await seedRunbookWithItem();

    await service.setItemStatus({
      itemId: "item-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "agent",
      actorSessionId: "sess-actor",
    });

    expect(notifyHumanHandoff).not.toHaveBeenCalled();
  });

  it("derives distinct agent subscribers from runbook operation provenance", async () => {
    await seedRunbookWithItem();
    await harness!.sql`
      INSERT INTO sessions (session_id, node_id, status, session_type)
      VALUES ('sess-agent-2', 'node-1', 'completed', 'claude')
    `;
    await service.createSection({
      runbookId: "rb-1",
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

    await expect(db.runbooks().listAgentSubscriberSessionIds("rb-1")).resolves.toEqual([
      "sess-actor",
      "sess-agent-2",
    ]);
  });

  it("derives human-turn items through item own assignee or section inheritance", async () => {
    await seedRunbook();
    await service.createSection({
      runbookId: "rb-1",
      sectionId: "sec-human",
      title: "Human section",
      actorSessionId: "sess-actor",
      assignee: { kind: "human", userId: "user-1" },
    });
    await service.createItem({
      runbookId: "rb-1",
      sectionId: "sec-human",
      itemId: "item-inherited",
      title: "Inherited",
      actorSessionId: "sess-actor",
    });

    expect((await service.listMyTurnItems({ userId: "user-1" })).map((row) => row.item_id)).toEqual([
      "item-inherited",
    ]);

    const reassigned = await service.setItemAssignee({
      runbookId: "rb-1",
      itemId: "item-inherited",
      expectedVersion: 1,
      actorSessionId: "sess-actor",
      assignee: { kind: "agent", agentId: "agent-1" },
    });

    expect(reassigned.operation.operation_type).toBe("set_runbook_item_assignee");
    expect(await service.listMyTurnItems({ userId: "user-1" })).toEqual([]);
  });

  it("excludes completed runbooks from my-turn items while leaving the runbook readable", async () => {
    await seedRunbook();
    await service.createSection({
      runbookId: "rb-1",
      sectionId: "sec-human",
      title: "Human section",
      actorSessionId: "sess-actor",
      assignee: { kind: "human", userId: "user-1" },
    });
    await service.createItem({
      runbookId: "rb-1",
      sectionId: "sec-human",
      itemId: "item-human",
      title: "Human task",
      actorSessionId: "sess-actor",
    });

    expect((await service.listMyTurnItems({ userId: "user-1" })).map((row) => row.item_id)).toEqual([
      "item-human",
    ]);

    const completed = await service.setRunbookStatus({
      runbookId: "rb-1",
      expectedVersion: 1,
      status: "completed",
      actorKind: "user",
      actorSessionId: "sess-actor",
      actorUserId: "operator@example.com",
    });

    expect(completed.snapshot.runbook.status).toBe("completed");
    expect(await service.listMyTurnItems({ userId: "user-1" })).toEqual([]);
    await expect(service.getRunbook("rb-1")).resolves.toMatchObject({
      runbook: { status: "completed" },
    });
  });

  it("sets and clears section assignee through a first-class operation", async () => {
    await seedRunbook();
    await service.createSection({
      runbookId: "rb-1",
      sectionId: "sec-assign",
      title: "Assign",
      actorSessionId: "sess-actor",
    });

    const assigned = await service.setSectionAssignee({
      runbookId: "rb-1",
      sectionId: "sec-assign",
      expectedVersion: 1,
      actorSessionId: "sess-actor",
      assignee: { kind: "session", sessionId: "sess-actor" },
      idempotencyKey: "runbook:rb-1:section:sec-assign:assignee:sess",
    });
    const cleared = await service.setSectionAssignee({
      runbookId: "rb-1",
      sectionId: "sec-assign",
      expectedVersion: 2,
      actorSessionId: "sess-actor",
      assignee: null,
      idempotencyKey: "runbook:rb-1:section:sec-assign:assignee:null",
    });

    expect(assigned.operation.operation_type).toBe("set_runbook_section_assignee");
    expect(cleared.snapshot.sections.find((section) => section.id === "sec-assign")).toMatchObject({
      assignee_kind: null,
      assignee_session_id: null,
      version: 3,
    });
  });

  async function seedRunbook(): Promise<void> {
    await service.createRunbook({
      runbookId: "rb-1",
      folderId: "folder-1",
      title: "Runbook",
      actorSessionId: "sess-actor",
    });
  }

  async function seedRunbookWithItem(): Promise<void> {
    await seedRunbook();
    await service.createSection({
      runbookId: "rb-1",
      sectionId: "sec-1",
      title: "Spec",
      actorSessionId: "sess-actor",
    });
    await service.createItem({
      runbookId: "rb-1",
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

async function waitForMockCall(mock: ReturnType<typeof vi.fn>): Promise<void> {
  const startedAt = Date.now();
  while (mock.mock.calls.length === 0 && Date.now() - startedAt < 500) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

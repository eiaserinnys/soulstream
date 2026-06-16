import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
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
    service = new RunbookService(db, { emitRunbookUpdated });
  }, 45_000);

  beforeEach(async () => {
    if (!harness) return;
    await resetRunbookData(harness.sql);
    emitRunbookUpdated.mockClear();
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

    await service.patchItem({
      runbookId: "rb-1",
      itemId: "item-inherited",
      expectedVersion: 1,
      actorSessionId: "sess-actor",
      assignee: { kind: "agent", agentId: "agent-1" },
    });

    expect(await service.listMyTurnItems({ userId: "user-1" })).toEqual([]);
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

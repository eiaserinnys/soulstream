import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import { listStarredTasks } from "../src/planner/planner_repository_reads.js";
import { listFullStarredTasks } from "../src/planner/planner_starred_task_reads.js";
import { PlannerRepository } from "../src/planner/planner_repository.js";
import {
  PLANNER_STARRED_TASK_ORDER_LOCK,
  PlannerStarredTaskMembershipConflictError,
} from "../src/planner/planner_starred_task_order.js";
import { PageRepository } from "../src/page/page_repository.js";
import type { PageYjsReplica } from "../src/page/page_yjs_model.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page/page_postgres_harness.js";

let harness: PagePostgresHarness;
let repository: PageRepository;

describe("starred task ordering PostgreSQL contract", () => {
  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    repository = new PageRepository(createLiveDbSqlResolver({ sql: harness.liveSql }));
    await harness.sql`DROP TABLE planner_starred_task_order`;
    await seedStarredPage("legacy-order-a", "2026-09-22T00:00:00Z");
    await seedStarredPage("legacy-order-b", "2026-09-23T00:00:00Z");
    const migration = await readFile(
      new URL("../../packages/db-schema/sql/migrations/096_planner_starred_task_order.sql", import.meta.url),
      "utf8",
    );
    await harness.sql.unsafe(migration);
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("backfills existing active stars in their previous visible order", async () => {
    await expect(orderedPageIds()).resolves.toEqual(["legacy-order-b", "legacy-order-a"]);
    await resetDatabase();
  });

  it("uses position,page_id for compact and full reads and opaque page boundaries", async () => {
    await resetDatabase();
    await seedStarredPage("order-a", "2026-09-22T00:00:00Z");
    await seedStarredPage("order-b", "2026-09-23T00:00:00Z");
    await seedStarredPage("order-c", "2026-09-24T00:00:00Z");
    await harness.sql`
      INSERT INTO planner_starred_task_order (page_id, position)
      VALUES ('order-b', 2), ('order-a', 2), ('order-c', 7)
    `;

    const compactFirst = await listStarredTasks(harness.liveSql, { limit: 2 });
    expect(compactFirst.items.map((page) => page.id)).toEqual(["order-a", "order-b"]);
    expect(compactFirst.next_cursor).toBeTruthy();
    const compactSecond = await listStarredTasks(harness.liveSql, {
      limit: 2,
      cursor: compactFirst.next_cursor!,
    });
    expect(compactSecond.items.map((page) => page.id)).toEqual(["order-c"]);

    const fullFirst = await listFullStarredTasks(harness.liveSql, { limit: 2 });
    expect(fullFirst.items.map((task) => task.page.id)).toEqual(["order-a", "order-b"]);
    expect(fullFirst.next_cursor).toBeTruthy();
    const fullSecond = await listFullStarredTasks(harness.liveSql, {
      limit: 2,
      cursor: fullFirst.next_cursor!,
    });
    expect(fullSecond.items.map((task) => task.page.id)).toEqual(["order-c"]);
  });

  it("adds, removes, appends on re-star and archive restore, and preserves content edits", async () => {
    await resetDatabase();
    const a = makeReplica("member-a", true);
    const b = makeReplica("member-b", true);
    await repository.storePageYjsState({ documentName: "page:member-a", snapshot: new Uint8Array([1]), replica: a });
    await repository.storePageYjsState({ documentName: "page:member-b", snapshot: new Uint8Array([2]), replica: b });
    await expect(orderedPageIds()).resolves.toEqual(["member-a", "member-b"]);

    await repository.storePageYjsState({
      documentName: "page:member-a",
      snapshot: new Uint8Array([3]),
      replica: makeReplica("member-a", true, { title: "Edited" }),
    });
    await expect(orderedPageIds()).resolves.toEqual(["member-a", "member-b"]);

    const changedIdentity = makeReplica("member-a", true);
    changedIdentity.blocks[0]!.properties.taskId = "replacement-task";
    await repository.storePageYjsState({
      documentName: "page:member-a",
      snapshot: new Uint8Array([31]),
      replica: changedIdentity,
    });
    await expect(orderedPageIds()).resolves.toEqual(["member-a", "member-b"]);

    const noPrimaryIdentity = makeReplica("member-a", true);
    noPrimaryIdentity.blocks[0]!.properties.primary = false;
    await repository.storePageYjsState({
      documentName: "page:member-a",
      snapshot: new Uint8Array([32]),
      replica: noPrimaryIdentity,
    });
    await expect(orderedPageIds()).resolves.toEqual(["member-b"]);
    await repository.storePageYjsState({
      documentName: "page:member-a",
      snapshot: new Uint8Array([33]),
      replica: makeReplica("member-a", true),
    });
    await expect(orderedPageIds()).resolves.toEqual(["member-b", "member-a"]);

    await repository.storePageYjsState({
      documentName: "page:member-a",
      snapshot: new Uint8Array([4]),
      replica: makeReplica("member-a", false),
    });
    await expect(orderedPageIds()).resolves.toEqual(["member-b"]);
    await repository.storePageYjsState({
      documentName: "page:member-a",
      snapshot: new Uint8Array([5]),
      replica: makeReplica("member-a", true),
    });
    await expect(orderedPageIds()).resolves.toEqual(["member-b", "member-a"]);

    await repository.storePageYjsState({
      documentName: "page:member-b",
      snapshot: new Uint8Array([6]),
      replica: makeReplica("member-b", true, { archived: true }),
    });
    await expect(orderedPageIds()).resolves.toEqual(["member-a"]);
    await repository.storePageYjsState({
      documentName: "page:member-b",
      snapshot: new Uint8Array([7]),
      replica: makeReplica("member-b", true),
    });
    await expect(orderedPageIds()).resolves.toEqual(["member-a", "member-b"]);
  });

  it("keeps invalid JSON membership types out of backfill, reads, and moves", async () => {
    await resetDatabase();
    const malformedPrimary = makeReplica("malformed-primary", true);
    malformedPrimary.blocks[0]!.properties.primary = "true";
    const malformedStarred = makeReplica("malformed-starred", true);
    malformedStarred.page.metadata.starred = "true";
    const malformedIdentity = makeReplica("malformed-identity", true);
    malformedIdentity.blocks[0]!.type = "runbook_ref";
    delete malformedIdentity.blocks[0]!.properties.taskId;
    malformedIdentity.blocks[0]!.properties.runbookId = 123;
    const malformedWhitespaceIdentity = makeReplica("malformed-whitespace-identity", true);
    malformedWhitespaceIdentity.blocks[0]!.type = "runbook_ref";
    delete malformedWhitespaceIdentity.blocks[0]!.properties.taskId;
    malformedWhitespaceIdentity.blocks[0]!.properties.runbookId = "\t";
    for (const [id, replica] of [
      ["malformed-primary", malformedPrimary],
      ["malformed-starred", malformedStarred],
      ["malformed-identity", malformedIdentity],
      ["malformed-whitespace-identity", malformedWhitespaceIdentity],
    ] as const) {
      await repository.storePageYjsState({
        documentName: `page:${id}`,
        snapshot: new Uint8Array([id.length]),
        replica,
      });
    }

    const migration = await readFile(
      new URL("../../packages/db-schema/sql/migrations/096_planner_starred_task_order.sql", import.meta.url),
      "utf8",
    );
    await harness.sql.unsafe(migration);
    await expect(orderedPageIds()).resolves.toEqual([]);

    await harness.sql`
      INSERT INTO planner_starred_task_order (page_id, position)
      VALUES ('malformed-primary', 0), ('malformed-starred', 1), ('malformed-identity', 2),
        ('malformed-whitespace-identity', 3)
    `;
    await expect(listStarredTasks(harness.liveSql, { limit: 10 }))
      .resolves.toMatchObject({ items: [] });
    await expect(listFullStarredTasks(harness.liveSql, { limit: 10 }))
      .resolves.toMatchObject({ items: [] });

    const planner = new PlannerRepository(createLiveDbSqlResolver({ sql: harness.liveSql }));
    for (const id of [
      "malformed-primary",
      "malformed-starred",
      "malformed-identity",
      "malformed-whitespace-identity",
    ]) {
      await expect(planner.moveStarredTask({ pageId: id, beforePageId: null }))
        .rejects.toBeInstanceOf(PlannerStarredTaskMembershipConflictError);
    }
  });

  it("rolls back snapshot, page, block, and order projection together", async () => {
    await resetDatabase();
    await repository.storePageYjsState({
      documentName: "page:existing-block-owner",
      snapshot: new Uint8Array([8]),
      replica: makeReplica("existing-block-owner", false, { blockId: "duplicate-block" }),
    });

    await expect(repository.storePageYjsState({
      documentName: "page:must-rollback",
      snapshot: new Uint8Array([9]),
      replica: makeReplica("must-rollback", true, { blockId: "duplicate-block" }),
    })).rejects.toThrow();

    const [{ pages, documents, orderRows }] = await harness.sql<[{ pages: number; documents: number; orderRows: number }]>`
      SELECT
        (SELECT count(*)::int FROM pages WHERE id = 'must-rollback') AS pages,
        (SELECT count(*)::int FROM board_yjs_documents WHERE name = 'page:must-rollback') AS documents,
        (SELECT count(*)::int FROM planner_starred_task_order WHERE page_id = 'must-rollback') AS "orderRows"
    `;
    expect({ pages, documents, orderRows }).toEqual({ pages: 0, documents: 0, orderRows: 0 });
  });

  it("moves against the full membership, supports global end, and returns 409 for stale members", async () => {
    await resetDatabase();
    for (const id of ["move-a", "move-b", "move-c"]) {
      await repository.storePageYjsState({
        documentName: `page:${id}`,
        snapshot: new Uint8Array([id.charCodeAt(id.length - 1)]),
        replica: makeReplica(id, true),
      });
    }
    const resolver = createLiveDbSqlResolver({ sql: harness.liveSql });
    const planner = new PlannerRepository(resolver);
    const firstPage = await listStarredTasks(harness.liveSql, { limit: 2 });
    expect(firstPage.items.map((page) => page.id)).toEqual(["move-a", "move-b"]);

    await expect(planner.moveStarredTask({ pageId: "move-a", beforePageId: "move-c" }))
      .resolves.toMatchObject({ changed: true, pageVersion: 1 });
    await expect(orderedPageIds()).resolves.toEqual(["move-b", "move-a", "move-c"]);
    await planner.moveStarredTask({ pageId: "move-b", beforePageId: null });
    await expect(orderedPageIds()).resolves.toEqual(["move-a", "move-c", "move-b"]);

    await expect(planner.moveStarredTask({ pageId: "missing", beforePageId: "move-c" }))
      .rejects.toBeInstanceOf(PlannerStarredTaskMembershipConflictError);
    await repository.storePageYjsState({
      documentName: "page:move-c",
      snapshot: new Uint8Array([99]),
      replica: makeReplica("move-c", false),
    });
    await expect(planner.moveStarredTask({ pageId: "move-a", beforePageId: "move-c" }))
      .rejects.toBeInstanceOf(PlannerStarredTaskMembershipConflictError);
  });

  it("serializes concurrent move, add, and remove transactions without losing membership", async () => {
    await resetDatabase();
    for (const id of ["race-a", "race-b", "race-c", "race-remove"]) {
      await repository.storePageYjsState({
        documentName: `page:${id}`,
        snapshot: new Uint8Array([id.charCodeAt(id.length - 1)]),
        replica: makeReplica(id, true),
      });
    }
    const mainResolver = createLiveDbSqlResolver({ sql: harness.liveSql });
    const peerRepository = new PageRepository(
      createLiveDbSqlResolver({ sql: harness.peerLiveSql }),
    );
    const concurrentRepository = new PageRepository(
      createLiveDbSqlResolver({ sql: harness.concurrentLiveSql }),
    );
    const planner = new PlannerRepository(mainResolver);

    await harness.lockSql`
      SELECT pg_advisory_lock(hashtextextended(${PLANNER_STARRED_TASK_ORDER_LOCK}, 0))
    `;
    const concurrentMutations = Promise.all([
      planner.moveStarredTask({ pageId: "race-a", beforePageId: "race-c" }),
      peerRepository.storePageYjsState({
        documentName: "page:race-add",
        snapshot: new Uint8Array([111]),
        replica: makeReplica("race-add", true),
      }),
      concurrentRepository.storePageYjsState({
        documentName: "page:race-remove",
        snapshot: new Uint8Array([112]),
        replica: makeReplica("race-remove", false),
      }),
    ]);
    let waitingTransactions = 0;
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [{ waiting }] = await harness.lockSql<[{ waiting: number }]>`
          SELECT count(*)::int AS waiting
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND granted = FALSE
            AND pid <> pg_backend_pid()
        `;
        waitingTransactions = waiting;
        if (waitingTransactions === 3) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await harness.lockSql`
        SELECT pg_advisory_unlock(hashtextextended(${PLANNER_STARRED_TASK_ORDER_LOCK}, 0))
      `;
    }
    await concurrentMutations;
    expect(waitingTransactions).toBe(3);

    const ids = await orderedPageIds();
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual(expect.arrayContaining(["race-a", "race-b", "race-c", "race-add"]));
    expect(ids).not.toContain("race-remove");
    expect(ids.indexOf("race-a")).toBeLessThan(ids.indexOf("race-c"));
    const [{ rows, members, positions }] = await harness.sql<[{ rows: number; members: number; positions: number }]>`
      SELECT count(*)::int AS rows,
             count(DISTINCT page_id)::int AS members,
             count(DISTINCT position)::int AS positions
      FROM planner_starred_task_order
    `;
    expect({ rows, members, positions }).toEqual({ rows: 4, members: 4, positions: 4 });
  });
});

async function resetDatabase(): Promise<void> {
  await harness.sql`TRUNCATE pages, board_yjs_documents CASCADE`;
}

async function seedStarredPage(id: string, updatedAt: string): Promise<void> {
  await harness.sql`
    INSERT INTO pages (id, title, version, archived, daily_date, metadata, updated_at)
    VALUES (${id}, ${id}, 1, FALSE, NULL, ${harness.sql.json({ starred: true })}::jsonb, ${updatedAt}::timestamptz)
  `;
  await harness.sql`
    INSERT INTO blocks (id, page_id, position_key, block_type, properties)
    VALUES (${`${id}-identity`}, ${id}, 'a', 'task_ref', ${harness.sql.json({ primary: true, taskId: `${id}-task` })}::jsonb)
  `;
}

function makeReplica(
  id: string,
  starred: boolean,
  options: { archived?: boolean; title?: string; blockId?: string } = {},
): PageYjsReplica {
  return {
    page: {
      id,
      title: options.title ?? id,
      dailyDate: null,
      mutationVersion: 1,
      archived: options.archived ?? false,
      metadata: { starred },
    },
    blocks: [{
      id: options.blockId ?? `${id}-identity`,
      parentId: null,
      positionKey: "a",
      type: "task_ref",
      text: "",
      textDelta: [],
      properties: { primary: true, taskId: `${id}-task` },
      collapsed: false,
    }],
  };
}

async function orderedPageIds(): Promise<string[]> {
  const rows = await harness.sql<readonly { page_id: string }[]>`
    SELECT page_id FROM planner_starred_task_order ORDER BY position, page_id
  `;
  return rows.map((row) => row.page_id);
}

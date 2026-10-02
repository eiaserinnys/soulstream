import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";
import { syncBoardYjsReplicaWithSql } from "../src/board-yjs/board_yjs_replica_sync.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import type { BoardYjsQuerySql } from "../src/board-yjs/board_yjs_sql.js";
import type { BoardYjsReplica } from "../src/board-yjs/board_yjs_types.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";

describe("board Y.Doc set-based replica sync (PostgreSQL)", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  async function save(folderId: string, replica: BoardYjsReplica): Promise<number> {
    let statements = 0;
    const sql = createBoardYjsSqlAdapter(harness.sql as unknown as LivePostgresSql);
    await sql.begin(async (transaction) => {
      const counted = Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) => {
          statements += 1;
          return transaction(strings, ...values);
        },
        { json: transaction.json, array: transaction.array },
      ) as BoardYjsQuerySql;
      await syncBoardYjsReplicaWithSql(counted, { folderId }, replica, `board-folder:${folderId}`);
    });
    return statements;
  }

  it("changes only the edited document timestamp, preserving all other rows", async () => {
    const replica = fixture("timestamps", 3);
    await harness.sql`INSERT INTO folders (id, name) VALUES ('timestamps', 'Timestamps')`;
    await save("timestamps", replica);
    // A fixed earlier timestamp avoids relying on wall-clock delays between transactions.
    await harness.sql`UPDATE board_items SET updated_at = '2000-01-01'::timestamptz WHERE folder_id = 'timestamps'`;
    await harness.sql`UPDATE markdown_documents SET updated_at = '2000-01-01'::timestamptz WHERE id LIKE 'timestamps-%'`;
    const before = await readRows(harness, "timestamps");

    replica.markdownDocuments[0]!.body = "바뀐 본문";
    replica.markdownDocuments[0]!.version += 1;
    await save("timestamps", replica);

    const after = await readRows(harness, "timestamps");
    expect(after.boardItems).toEqual(before.boardItems);
    expect(after.documents.slice(1)).toEqual(before.documents.slice(1));
    expect(after.documents[0]).toMatchObject({ body: "바뀐 본문", version: 2 });
    expect(after.documents[0]!.updated_at).not.toEqual(before.documents[0]!.updated_at);
    expect(after.documents[0]!.created_at).toEqual(before.documents[0]!.created_at);
  });

  it("projects additions, deletions, coordinates, metadata and titles without changing cache contents", async () => {
    const replica = fixture("changes", 3);
    await harness.sql`INSERT INTO folders (id, name) VALUES ('changes', 'Changes')`;
    await save("changes", replica);
    const removed = replica.boardItems.shift()!;
    replica.boardItems.push(fixture("changes", 4).boardItems[3]!);
    replica.boardItems[0]!.x = 17.25;
    replica.boardItems[0]!.y = -29.5;
    replica.boardItems[1]!.metadata = { title: "메타데이터", nested: { enabled: true } };
    replica.markdownDocuments[1]!.title = "바뀐 제목";
    await save("changes", replica);

    const rows = await readRows(harness, "changes");
    expect(rows.boardItems.map((row) => row.id)).not.toContain(removed.id);
    expect(rows.boardItems.map(({ created_at, updated_at, ...row }) => row)).toEqual(
      replica.boardItems.map((item) => ({
        id: item.id, folder_id: "changes", membership_kind: item.membershipKind ?? "primary",
        item_type: item.itemType, item_id: item.itemId, x: item.x, y: item.y, metadata: item.metadata ?? {},
      })),
    );
    expect(rows.documents.map(({ created_at, updated_at, ...row }) => row)).toEqual(replica.markdownDocuments);
    await expect(harness.sql`
      SELECT board_items, markdown_documents FROM board_yjs_catalog_cache WHERE folder_id = 'changes'
    `).resolves.toEqual([{ board_items: replica.boardItems, markdown_documents: replica.markdownDocuments }]);
  });

  it("executes six statements for both 1 and 200 items/documents, skipping empty upserts", async () => {
    await harness.sql`INSERT INTO folders (id, name) VALUES ('small', 'Small'), ('large', 'Large'), ('empty', 'Empty')`;
    const small = await save("small", fixture("small", 1));
    const large = await save("large", fixture("large", 200));
    const empty = await save("empty", { boardItems: [], markdownDocuments: [] });
    expect({ small, large, empty }).toEqual({ small: 6, large: 6, empty: 4 });
    console.info(`replica SQL statements: 1+1=${small}, 200+200=${large}, empty=${empty}`);
  });

  it("preserves the previous nullish membership and metadata defaults", async () => {
    const replica = fixture("defaults", 2);
    // Older replicas can omit metadata despite the current row interface requiring it.
    Reflect.deleteProperty(replica.boardItems[0]!, "metadata");
    Object.assign(replica.boardItems[1]!, { membershipKind: null, metadata: null });
    await harness.sql`INSERT INTO folders (id, name) VALUES ('defaults', 'Defaults')`;
    await save("defaults", replica);
    await expect(harness.sql`
      SELECT membership_kind, metadata FROM board_items WHERE folder_id = 'defaults' ORDER BY id
    `).resolves.toEqual([
      { membership_kind: "primary", metadata: {} },
      { membership_kind: "primary", metadata: {} },
    ]);
  });
});

function fixture(folderId: string, count: number): BoardYjsReplica {
  const markdownDocuments = Array.from({ length: count }, (_, index) => ({
    id: `${folderId}-${String(index).padStart(3, "0")}`, title: `문서 ${index}`, body: `본문 ${index}`, version: 1,
  }));
  return {
    boardItems: markdownDocuments.map((document, index) => ({
      id: `markdown:${document.id}`, folderId: "ignored-replica-folder", itemType: "markdown" as const,
      itemId: document.id, x: index + 0.5, y: index * 10, metadata: {},
      ...(index === 1 ? { membershipKind: "reference" as const } : {}),
    })),
    markdownDocuments,
  };
}

async function readRows(harness: FullSchemaPostgresHarness, folderId: string) {
  const boardItems = await harness.sql`
    SELECT id, folder_id, membership_kind, item_type, item_id, x, y, metadata, created_at, updated_at
    FROM board_items WHERE folder_id = ${folderId} ORDER BY id
  `;
  const documents = await harness.sql`
    SELECT id, title, body, version, created_at, updated_at
    FROM markdown_documents WHERE id LIKE ${`${folderId}-%`} ORDER BY id
  `;
  return { boardItems: [...boardItems], documents: [...documents] };
}

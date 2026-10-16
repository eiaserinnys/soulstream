import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresTestContainer } from "../../../packages/db-schema/scripts/postgres-test-container.mjs";
import { extractRelationalSources } from "../../scripts/attachment-migration/extract_relational.js";
import { RELATIONAL_SOURCES_EXPORTED } from "../../scripts/attachment-migration/inventory_contract.js";
import { waitForPostgres } from "../persistent-session-settings-world.js";

const CUTOFF = "2026-10-17T00:00:00.000Z";
const AFTER = "2026-10-17T00:00:00.001Z";

describe("read-only relational attachment inventory against PostgreSQL", () => {
  let sql: ReturnType<typeof postgres>;
  let stop: (() => void) | undefined;

  beforeAll(async () => {
    const container = startPostgresTestContainer({ user: "attachment_inventory_test", password: "attachment_inventory_test", database: "attachment_inventory_test_db" });
    stop = container.stop;
    const url = `postgres://attachment_inventory_test:attachment_inventory_test@127.0.0.1:${container.port}/attachment_inventory_test_db`;
    const bootstrap = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await waitForPostgres(bootstrap);
      const schema = await readFile(new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8");
      await bootstrap.unsafe(schema);
    } finally {
      await bootstrap.end({ timeout: 2 });
    }
    sql = postgres(url, { max: 2, onnotice: () => undefined });
    expect(Number((await sql`SELECT COUNT(*) AS n FROM cards`)[0]!.n)).toBe(0);
    await sql`INSERT INTO folders(id,name) VALUES ('attachment-inventory-folder','inventory')`;
  }, 90_000);

  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    stop?.();
  });

  it("includes created_at equal to cutoff, excludes later rows, and marks updated rows as drift", async () => {
    await sql`INSERT INTO cards(id,folder_id,position_key,title,request,attachments,items,created_at,updated_at)
      VALUES ('include-card','attachment-inventory-folder','a','포함','![x](/api/attachments/files?nodeId=node-a&path=a.png)',
        ${sql.json([{ nodeId: "node-a", path: "a.png", name: "a.png", mimeType: "image/png" }])},
        ${sql.json([{ title: "항목", evidence: [{ type: "image", url: "/api/attachments/files?nodeId=node-a&path=a.png" }] }])},
        ${new Date(CUTOFF)},${new Date(AFTER)})`;
    await sql`INSERT INTO cards(id,folder_id,position_key,title,request,attachments,items,created_at,updated_at)
      VALUES ('exclude-card','attachment-inventory-folder','b','제외','![x](/api/attachments/files?nodeId=node-a&path=later.png)',
        '[]'::jsonb,'[]'::jsonb,${new Date(AFTER)},${new Date(AFTER)})`;
    await sql`INSERT INTO card_reports(id,card_id,title,format,body,created_at)
      VALUES ('inventory-report','include-card','보고','markdown','![x](/api/attachments/files?nodeId=node-a&path=report.png)',${new Date(CUTOFF)})`;
    await sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body,created_at)
      VALUES ('inventory-note','include-card','agent','note','![x](/api/attachments/files?nodeId=node-a&path=note.png)',${new Date(CUTOFF)})`;
    await sql`INSERT INTO folder_operations(id,folder_id,target_kind,target_id,operation_type,payload_json,created_at)
      VALUES ('inventory-operation','attachment-inventory-folder','card','include-card','report_card_item',
        ${sql.json({ evidence: [{ type: "image", url: "/api/attachments/files?nodeId=node-a&path=history.png" }] })},${new Date(CUTOFF)})`;
    await sql`INSERT INTO file_assets(id,storage_key,storage_purpose,original_name,mime_type,byte_size,upload_status,created_at,updated_at)
      VALUES ('inventory-asset','inventory/asset','attachment','asset.png','image/png',4,'committed',${new Date(CUTOFF)},${new Date(AFTER)})`;
    await sql`INSERT INTO board_items(id,folder_id,item_type,item_id,created_at,updated_at)
      VALUES ('inventory-board-item','attachment-inventory-folder','asset','inventory-asset',${new Date(CUTOFF)},${new Date(AFTER)})`;

    const sources = await collect(extractRelationalSources(sql as never, { pageSize: 1, cutoff: CUTOFF }));
    const cardSources = sources.filter((source) => source.source_table === "cards");
    expect(cardSources.some((source) => source.source_pk === "include-card")).toBe(true);
    expect(cardSources.some((source) => source.source_pk === "exclude-card")).toBe(false);
    expect(cardSources.filter((source) => source.source_pk === "include-card").every((source) => source.changed_after_cutoff)).toBe(true);
    expect(new Set(sources.map((source) => source.source_table))).toEqual(new Set([
      "cards", "card_reports", "card_comments", "folder_operations", "file_assets", "board_items",
    ]));
    expect(sources.every((source) => source.created_at <= CUTOFF)).toBe(true);
    process.stdout.write(`${RELATIONAL_SOURCES_EXPORTED}\n`);
  });

  it("rejects JSONB values double-stored as serialized JSON strings", async () => {
    await sql`INSERT INTO cards(id,folder_id,position_key,title,request,attachments,items,created_at,updated_at)
      VALUES ('double-json-card','attachment-inventory-folder','z','잘못된 JSON','',
        '"[]"'::jsonb,'[]'::jsonb,${new Date(CUTOFF)},${new Date(CUTOFF)})`;
    await expect(collect(extractRelationalSources(sql as never, { pageSize: 5, cutoff: CUTOFF })))
      .rejects.toMatchObject({ code: "INVENTORY_INVALID_SOURCE" });
  });

  it("PostgreSQL rejects writes in the read-only transaction mode used by inventory", async () => {
    await expect(sql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx`INSERT INTO folders(id,name) VALUES ('must-not-write','inventory')`;
    })).rejects.toThrow(/read.only transaction/i);
    expect(Number((await sql`SELECT COUNT(*) AS n FROM folders WHERE id='must-not-write'`)[0]!.n)).toBe(0);
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

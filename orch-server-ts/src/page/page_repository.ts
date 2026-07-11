import { Buffer } from "node:buffer";

import type {
  LiveDbSqlResolver,
  LivePostgresSql,
} from "../runtime/live_db_sql.js";
import {
  parsePageYjsDocumentName,
  type PageYjsReplica,
} from "./page_yjs_model.js";
import type { StorePageYjsStateInput } from "./page_yjs_persistence.js";

type PageQuerySql = {
  <T extends readonly Record<string, unknown>[] = readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  readonly json: (value: unknown) => unknown;
  readonly array: (values: readonly unknown[]) => unknown;
};

type PageSql = PageQuerySql & {
  readonly begin: <T>(callback: (sql: PageQuerySql) => Promise<T>) => Promise<T>;
};

type PageCapableSql = LivePostgresSql & {
  readonly array: (values: readonly unknown[]) => unknown;
  readonly begin: <T>(callback: (sql: LivePostgresSql) => Promise<T>) => Promise<T>;
};

export class PageRepository {
  private sql?: Promise<PageSql>;

  constructor(private readonly resolver: LiveDbSqlResolver) {}

  async getPageYjsSnapshot(documentName: string): Promise<Uint8Array | null> {
    requirePageDocumentName(documentName);
    const sql = await this.resolveSql();
    const rows = await sql<readonly { snapshot: Buffer | Uint8Array }[]>`
      SELECT snapshot FROM board_yjs_documents WHERE name = ${documentName}
    `;
    const snapshot = rows[0]?.snapshot;
    return snapshot ? new Uint8Array(snapshot) : null;
  }

  async storePageYjsState(input: StorePageYjsStateInput): Promise<void> {
    const pageId = requirePageDocumentName(input.documentName);
    if (input.replica.page.id !== pageId) {
      throw new Error(
        `page id mismatch: document ${pageId}, replica ${input.replica.page.id}`,
      );
    }
    const sql = await this.resolveSql();
    await sql.begin(async (transaction) => {
      await storeDocument(transaction, input.documentName, input.snapshot);
      if (input.update) {
        await transaction`
          INSERT INTO board_yjs_updates (document_name, update)
          VALUES (${input.documentName}, ${Buffer.from(input.update)})
        `;
      }
      await upsertPage(transaction, input.replica);
      await reconcileBlocks(transaction, input.replica);
    });
  }

  private resolveSql(): Promise<PageSql> {
    this.sql ??= this.resolver.resolveSql().then(createPageSqlAdapter);
    return this.sql;
  }
}

async function storeDocument(
  sql: PageQuerySql,
  documentName: string,
  snapshot: Uint8Array,
): Promise<void> {
  await sql`
    INSERT INTO board_yjs_documents (name, snapshot, updated_at)
    VALUES (${documentName}, ${Buffer.from(snapshot)}, NOW())
    ON CONFLICT (name) DO UPDATE
    SET snapshot = EXCLUDED.snapshot,
        updated_at = EXCLUDED.updated_at
    WHERE board_yjs_documents.snapshot IS DISTINCT FROM EXCLUDED.snapshot
  `;
}

async function upsertPage(sql: PageQuerySql, replica: PageYjsReplica): Promise<void> {
  const page = replica.page;
  await sql`
    INSERT INTO pages (
      id, title, daily_date, version, archived, metadata, updated_at
    ) VALUES (
      ${page.id}, ${page.title}, ${page.dailyDate}, ${page.mutationVersion},
      ${page.archived}, ${sql.json(page.metadata)}::jsonb, NOW()
    )
    ON CONFLICT (id) DO UPDATE
    SET title = EXCLUDED.title,
        daily_date = EXCLUDED.daily_date,
        version = EXCLUDED.version,
        archived = EXCLUDED.archived,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at
    WHERE (pages.title, pages.daily_date, pages.version, pages.archived, pages.metadata)
      IS DISTINCT FROM
      (EXCLUDED.title, EXCLUDED.daily_date, EXCLUDED.version, EXCLUDED.archived, EXCLUDED.metadata)
  `;
}

async function reconcileBlocks(sql: PageQuerySql, replica: PageYjsReplica): Promise<void> {
  const blockIds = replica.blocks.map((block) => block.id);
  if (blockIds.length === 0) {
    await sql`DELETE FROM blocks WHERE page_id = ${replica.page.id}`;
  } else {
    await sql`
      DELETE FROM blocks
      WHERE page_id = ${replica.page.id}
        AND id <> ALL(${sql.array(blockIds)})
    `;
  }
  for (const block of replica.blocks) {
    await sql`
      INSERT INTO blocks (
        id, page_id, parent_id, position_key, block_type,
        text_plain, properties, collapsed, updated_at
      ) VALUES (
        ${block.id}, ${replica.page.id}, ${block.parentId}, ${block.positionKey},
        ${block.type}, ${block.text}, ${sql.json(block.properties)}::jsonb,
        ${block.collapsed}, NOW()
      )
      ON CONFLICT (page_id, id) DO UPDATE
      SET page_id = EXCLUDED.page_id,
          parent_id = EXCLUDED.parent_id,
          position_key = EXCLUDED.position_key,
          block_type = EXCLUDED.block_type,
          text_plain = EXCLUDED.text_plain,
          properties = EXCLUDED.properties,
          collapsed = EXCLUDED.collapsed,
          updated_at = EXCLUDED.updated_at
      WHERE (
        blocks.page_id, blocks.parent_id, blocks.position_key, blocks.block_type,
        blocks.text_plain, blocks.properties, blocks.collapsed
      ) IS DISTINCT FROM (
        EXCLUDED.page_id, EXCLUDED.parent_id, EXCLUDED.position_key, EXCLUDED.block_type,
        EXCLUDED.text_plain, EXCLUDED.properties, EXCLUDED.collapsed
      )
    `;
  }
}

function createPageSqlAdapter(sql: LivePostgresSql): PageSql {
  assertPageCapableSql(sql);
  const query = createPageQueryAdapter(sql);
  return Object.assign(query, {
    begin: <T>(callback: (transaction: PageQuerySql) => Promise<T>) =>
      sql.begin((transaction) => callback(createPageQueryAdapter(transaction))),
  }) as PageSql;
}

function createPageQueryAdapter(sql: LivePostgresSql): PageQuerySql {
  assertPageCapableQuerySql(sql);
  const query = async <T extends readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> => await sql(strings, ...values) as T;
  return Object.assign(query, {
    json: (value: unknown) => sql.json(value),
    array: (values: readonly unknown[]) => sql.array(values),
  }) as PageQuerySql;
}

function assertPageCapableSql(sql: LivePostgresSql): asserts sql is PageCapableSql {
  assertPageCapableQuerySql(sql);
  const candidate = sql as Partial<PageCapableSql>;
  if (typeof candidate.begin !== "function") {
    throw new Error("page Yjs SQL requires postgres.js begin()");
  }
}

function assertPageCapableQuerySql(
  sql: LivePostgresSql,
): asserts sql is LivePostgresSql & Pick<PageCapableSql, "array"> {
  const candidate = sql as Partial<PageCapableSql>;
  if (typeof candidate.array !== "function") {
    throw new Error("page Yjs SQL requires postgres.js array()");
  }
}

function requirePageDocumentName(documentName: string): string {
  const pageId = parsePageYjsDocumentName(documentName);
  if (!pageId) throw new Error(`PAGE_YJS_DOCUMENT_NAME_INVALID: ${documentName}`);
  return pageId;
}

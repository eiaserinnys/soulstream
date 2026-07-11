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
import type { PageMutationApplication } from "./page_mutation_core.js";
import { reconcilePageLinks } from "./page_link_projection.js";
import {
  findPageIdByDailyDate,
  findPageIdByTitle,
  getPageBacklinks,
  listPages,
  type PageBacklinkPage,
} from "./page_repository_reads.js";
import type { PageLinkKind, PageListDto } from "@soulstream/page-model";

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

export interface PageOperationRecord extends Record<string, unknown> {
  id: string;
  page_id: string;
  target_block_id: string | null;
  operation_type: string;
  actor_kind: "agent" | "user" | "system";
  actor_session_id: string | null;
  actor_event_id: number | null;
  actor_user_id: string | null;
  idempotency_key: string;
  expected_version: number;
  result_version: number;
  payload_json: Record<string, unknown>;
  reason: string | null;
  created_at: Date;
}

export interface PageMutationCommitResult {
  operation: PageOperationRecord;
  pageCreatedAt: Date;
  pageUpdatedAt: Date;
  idempotent: boolean;
}

export interface CommitPageMutationInput {
  documentName: string;
  application: PageMutationApplication;
  operationId: string;
}

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
      await reconcilePageLinks(transaction, input.replica);
    });
  }

  async getPageMutationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PageMutationCommitResult | null> {
    const sql = await this.resolveSql();
    return await findMutationByIdempotencyKey(sql, idempotencyKey);
  }

  async hasPageOperation(operationId: string): Promise<boolean> {
    const sql = await this.resolveSql();
    const rows = await sql<readonly { exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM block_operations WHERE id = ${operationId}) AS exists
    `;
    return rows[0]?.exists === true;
  }

  async getPageTimestamps(
    pageId: string,
  ): Promise<{ pageCreatedAt: Date; pageUpdatedAt: Date } | null> {
    const sql = await this.resolveSql();
    const rows = await sql<readonly { created_at: Date; updated_at: Date }[]>`
      SELECT created_at, updated_at FROM pages WHERE id = ${pageId}
    `;
    const row = rows[0];
    return row ? { pageCreatedAt: row.created_at, pageUpdatedAt: row.updated_at } : null;
  }

  async findPageIdByTitle(title: string): Promise<string | null> {
    return await findPageIdByTitle(await this.resolveSql(), title);
  }

  async findPageIdByDailyDate(date: string): Promise<string | null> {
    return await findPageIdByDailyDate(await this.resolveSql(), date);
  }

  async listPages(input: {
    starred?: boolean;
    cursor?: string;
    limit: number;
  }): Promise<PageListDto> {
    return await listPages(await this.resolveSql(), input);
  }

  async getPageBacklinks(input: {
    pageId: string;
    kinds: readonly PageLinkKind[];
    cursor?: string;
    limit: number;
  }): Promise<PageBacklinkPage> {
    return await getPageBacklinks(await this.resolveSql(), input);
  }

  async commitPageMutation(input: CommitPageMutationInput): Promise<PageMutationCommitResult> {
    const pageId = requirePageDocumentName(input.documentName);
    if (input.application.replica.page.id !== pageId) {
      throw new Error(`page id mismatch: document ${pageId}, replica ${input.application.replica.page.id}`);
    }
    const sql = await this.resolveSql();
    return await sql.begin(async (transaction) => {
      const existing = await findMutationByIdempotencyKey(
        transaction,
        input.application.idempotencyKey,
      );
      if (existing) return existing;

      const eventId = await appendBlockOperationEvent(transaction, input);
      const provenance = {
        actorSessionId: input.application.actor.actorSessionId ?? null,
        eventId,
      };
      await storeDocument(transaction, input.documentName, input.application.snapshot);
      const pageTimes = await upsertPage(transaction, input.application.replica, provenance);
      await reconcileBlocks(transaction, input.application.replica, provenance);
      await reconcilePageLinks(transaction, input.application.replica);
      const targetBlockId = input.application.targetBlockId &&
        input.application.replica.blocks.some((block) => block.id === input.application.targetBlockId)
        ? input.application.targetBlockId
        : null;
      const rows = await transaction<readonly PageOperationRecord[]>`
        INSERT INTO block_operations (
          id, page_id, target_block_id, operation_type,
          actor_kind, actor_session_id, actor_event_id, actor_user_id,
          idempotency_key, expected_version, result_version,
          payload_json, reason
        ) VALUES (
          ${input.operationId}, ${pageId}, ${targetBlockId},
          ${input.application.operationType}, ${input.application.actor.actorKind},
          ${input.application.actor.actorSessionId ?? null}, ${eventId},
          ${input.application.actor.actorUserId ?? null},
          ${input.application.idempotencyKey}, ${input.application.expectedVersion},
          ${input.application.resultVersion}, ${transaction.json(input.application.payload)}::jsonb,
          ${input.application.reason}
        )
        RETURNING *
      `;
      const operation = rows[0];
      if (!operation) throw new Error("block operation insert returned no row");
      return {
        operation,
        pageCreatedAt: pageTimes.created_at,
        pageUpdatedAt: pageTimes.updated_at,
        idempotent: false,
      };
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

interface MutationProvenance {
  actorSessionId: string | null;
  eventId: number | null;
}

async function upsertPage(
  sql: PageQuerySql,
  replica: PageYjsReplica,
  provenance?: MutationProvenance,
): Promise<{ created_at: Date; updated_at: Date }> {
  const page = replica.page;
  if (provenance) {
    const rows = await sql<readonly { created_at: Date; updated_at: Date }[]>`
      INSERT INTO pages (
        id, title, daily_date, version, archived, metadata,
        created_session_id, created_event_id, updated_session_id, updated_event_id,
        updated_at
      ) VALUES (
        ${page.id}, ${page.title}, ${page.dailyDate}, ${page.mutationVersion},
        ${page.archived}, ${sql.json(page.metadata)}::jsonb,
        ${provenance.actorSessionId}, ${provenance.eventId},
        ${provenance.actorSessionId}, ${provenance.eventId}, NOW()
      )
      ON CONFLICT (id) DO UPDATE
      SET title = EXCLUDED.title,
          daily_date = EXCLUDED.daily_date,
          version = EXCLUDED.version,
          archived = EXCLUDED.archived,
          metadata = EXCLUDED.metadata,
          updated_session_id = EXCLUDED.updated_session_id,
          updated_event_id = EXCLUDED.updated_event_id,
          updated_at = EXCLUDED.updated_at
      RETURNING created_at, updated_at
    `;
    const row = rows[0];
    if (!row) throw new Error("page upsert returned no row");
    return row;
  }
  const rows = await sql<readonly { created_at: Date; updated_at: Date }[]>`
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
    RETURNING created_at, updated_at
  `;
  return rows[0] ?? { created_at: new Date(0), updated_at: new Date(0) };
}

async function reconcileBlocks(
  sql: PageQuerySql,
  replica: PageYjsReplica,
  provenance?: MutationProvenance,
): Promise<void> {
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
    if (provenance) {
      await sql`
        INSERT INTO blocks (
          id, page_id, parent_id, position_key, block_type,
          text_plain, properties, collapsed,
          created_session_id, created_event_id, updated_session_id, updated_event_id,
          updated_at
        ) VALUES (
          ${block.id}, ${replica.page.id}, ${block.parentId}, ${block.positionKey},
          ${block.type}, ${block.text}, ${sql.json(block.properties)}::jsonb,
          ${block.collapsed}, ${provenance.actorSessionId}, ${provenance.eventId},
          ${provenance.actorSessionId}, ${provenance.eventId}, NOW()
        )
        ON CONFLICT (page_id, id) DO UPDATE
        SET parent_id = EXCLUDED.parent_id,
            position_key = EXCLUDED.position_key,
            block_type = EXCLUDED.block_type,
            text_plain = EXCLUDED.text_plain,
            properties = EXCLUDED.properties,
            collapsed = EXCLUDED.collapsed,
            updated_session_id = EXCLUDED.updated_session_id,
            updated_event_id = EXCLUDED.updated_event_id,
            updated_at = EXCLUDED.updated_at
      `;
      continue;
    }
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

async function appendBlockOperationEvent(
  sql: PageQuerySql,
  input: CommitPageMutationInput,
): Promise<number | null> {
  if (input.application.actor.actorKind !== "agent") return null;
  const rows = await sql<readonly { event_append: number }[]>`
    SELECT event_append(
      ${input.application.actor.actorSessionId},
      ${"block_operation"},
      ${JSON.stringify({
        operation_id: input.operationId,
        operation_type: input.application.operationType,
        page_id: input.application.replica.page.id,
        target_block_id: input.application.targetBlockId,
        payload: input.application.payload,
        reason: input.application.reason,
      })},
      ${`block operation ${input.application.operationType}`},
      ${new Date()},
      ${input.application.idempotencyKey}
    ) AS event_append
  `;
  const eventId = rows[0]?.event_append;
  if (typeof eventId !== "number") throw new Error("event_append returned no event id");
  return eventId;
}

async function findMutationByIdempotencyKey(
  sql: PageQuerySql,
  idempotencyKey: string,
): Promise<PageMutationCommitResult | null> {
  const rows = await sql<readonly (PageOperationRecord & {
    page_created_at: Date;
    page_updated_at: Date;
  })[]>`
    SELECT operation.*, page.created_at AS page_created_at,
           page.updated_at AS page_updated_at
    FROM block_operations operation
    JOIN pages page ON page.id = operation.page_id
    WHERE operation.idempotency_key = ${idempotencyKey}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const { page_created_at, page_updated_at, ...operation } = row;
  return {
    operation,
    pageCreatedAt: page_created_at,
    pageUpdatedAt: page_updated_at,
    idempotent: true,
  };
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

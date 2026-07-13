import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";

import type {
  LiveDbSqlResolver,
  LivePostgresSql,
} from "../runtime/live_db_sql.js";
import {
  parsePageYjsDocumentName,
} from "./page_yjs_model.js";
import type { StorePageYjsStateInput } from "./page_yjs_persistence.js";
import type { PageMutationApplication } from "./page_mutation_core.js";
import {
  PageMutationIdempotencyConflictError,
  PageMutationVersionConflictError,
} from "./page_mutation_helpers.js";
import { reconcilePageLinks } from "./page_link_projection.js";
import { reconcileChecklistProjectionOutbox } from "./page_checklist_projection_outbox.js";
import {
  findPageIdByDailyDate,
  findPageIdByTitle,
  getBrowserBacklinks,
  getBrowserBlock,
  getPageBacklinks,
  listPages,
  searchBrowserBlocks,
  searchBrowserPages,
  type PageBacklinkPage,
} from "./page_repository_reads.js";
import type {
  BrowserBacklinkPageDto,
  BrowserBlockDto,
  BrowserBlockSearchDto,
  BrowserPageSearchDto,
  PageLinkKind,
  PageListDto,
} from "@soulstream/page-model";
import {
  reconcileBlockProjection,
  storePageDocument,
  upsertPageProjection,
  type PageQuerySql,
} from "./page_repository_projection.js";

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

export interface CommitPageMutationsInput {
  mutations: readonly CommitPageMutationInput[];
  primaryBindings?: readonly {
    sessionId: string;
    blockId: string;
    targetPageId: string;
    targetVersion: number;
  }[];
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
      await storePageDocument(transaction, input.documentName, input.snapshot);
      if (input.update) {
        await transaction`
          INSERT INTO board_yjs_updates (document_name, update)
          VALUES (${input.documentName}, ${Buffer.from(input.update)})
        `;
      }
      await upsertPageProjection(transaction, input.replica);
      await reconcileBlockProjection(transaction, input.replica);
      await reconcileChecklistProjectionOutbox(transaction, input.replica);
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
    includeSelf?: boolean;
    limit: number;
  }): Promise<PageBacklinkPage> {
    return await getPageBacklinks(await this.resolveSql(), input);
  }

  async searchBrowserPages(input: {
    query: string;
    limit: number;
  }): Promise<BrowserPageSearchDto> {
    return await searchBrowserPages(await this.resolveSql(), input);
  }

  async searchBrowserBlocks(input: {
    query: string;
    limit: number;
  }): Promise<BrowserBlockSearchDto> {
    return await searchBrowserBlocks(await this.resolveSql(), input);
  }

  async getBrowserBlock(blockId: string): Promise<BrowserBlockDto | null> {
    return await getBrowserBlock(await this.resolveSql(), blockId);
  }

  async getBrowserBacklinks(input: {
    pageId: string;
    kinds: readonly PageLinkKind[];
    cursor?: string;
    includeSelf?: boolean;
    limit: number;
  }): Promise<BrowserBacklinkPageDto> {
    return await getBrowserBacklinks(await this.resolveSql(), input);
  }

  async commitPageMutation(input: CommitPageMutationInput): Promise<PageMutationCommitResult> {
    return (await this.commitPageMutations({ mutations: [input] }))[0]!;
  }

  async commitPageMutations(input: CommitPageMutationsInput): Promise<PageMutationCommitResult[]> {
    if (input.mutations.length === 0) throw new Error("page mutation transaction must not be empty");
    for (const mutation of input.mutations) assertMutationPageId(mutation);
    const sql = await this.resolveSql();
    return await sql.begin(async (transaction) => {
      const pageIds = [...new Set(input.mutations.map((mutation) => (
        requirePageDocumentName(mutation.documentName)
      )))].sort();
      for (const pageId of pageIds) {
        await transaction`
          SELECT pg_advisory_xact_lock(hashtextextended(${pageId}, 0))
        `;
      }
      const existing = await Promise.all(input.mutations.map((mutation) => (
        findMutationByIdempotencyKey(transaction, mutation.application.idempotencyKey)
      )));
      if (existing.every((result) => result !== null)) {
        const committed = existing as PageMutationCommitResult[];
        assertTransferIdempotencyPayloads(input.mutations, committed);
        return committed;
      }
      if (existing.some((result) => result !== null)) {
        if (hasTransferIdentity(input.mutations)) {
          throw new PageMutationIdempotencyConflictError();
        }
        throw new Error("partial page mutation transaction idempotency state");
      }
      for (const mutation of input.mutations) {
        await assertDatabaseMutationVersion(transaction, mutation);
      }
      const results: PageMutationCommitResult[] = [];
      for (const mutation of input.mutations) {
        results.push(await commitPageMutationInTransaction(transaction, mutation));
      }
      for (const binding of input.primaryBindings ?? []) {
        const rows = await transaction<readonly { session_id: string }[]>`
          UPDATE session_page_bindings
          SET target_page_id = ${binding.targetPageId},
              target_block_id = ${binding.blockId},
              target_expected_version = ${binding.targetVersion},
              page_state = 'bound',
              updated_at = NOW()
          WHERE session_id = ${binding.sessionId}
          RETURNING session_id
        `;
        if (!rows[0]) throw new Error(`primary session binding not found: ${binding.sessionId}`);
      }
      return results;
    });
  }

  private resolveSql(): Promise<PageSql> {
    this.sql ??= this.resolver.resolveSql().then(createPageSqlAdapter);
    return this.sql;
  }
}

function assertTransferIdempotencyPayloads(
  mutations: readonly CommitPageMutationInput[],
  committed: readonly PageMutationCommitResult[],
): void {
  for (const [index, mutation] of mutations.entries()) {
    const identity = mutation.application.payload.transfer_identity;
    if (
      identity !== undefined &&
      !isDeepStrictEqual(committed[index]?.operation.payload_json.transfer_identity, identity)
    ) {
      throw new PageMutationIdempotencyConflictError();
    }
  }
}

function hasTransferIdentity(mutations: readonly CommitPageMutationInput[]): boolean {
  return mutations.some((mutation) => mutation.application.payload.transfer_identity !== undefined);
}

async function assertDatabaseMutationVersion(
  sql: PageQuerySql,
  input: CommitPageMutationInput,
): Promise<void> {
  const pageId = requirePageDocumentName(input.documentName);
  const rows = await sql<readonly { version: number }[]>`
    SELECT version FROM pages WHERE id = ${pageId}
  `;
  const actualVersion = rows[0]?.version ?? 0;
  if (actualVersion !== input.application.expectedVersion) {
    throw new PageMutationVersionConflictError(
      pageId,
      input.application.expectedVersion,
      actualVersion,
    );
  }
}

async function commitPageMutationInTransaction(
  transaction: PageQuerySql,
  input: CommitPageMutationInput,
): Promise<PageMutationCommitResult> {
  const pageId = requirePageDocumentName(input.documentName);
  const eventId = await appendBlockOperationEvent(transaction, input);
  const provenance = {
    actorSessionId: input.application.actor.actorSessionId ?? null,
    eventId,
  };
  await storePageDocument(transaction, input.documentName, input.application.snapshot);
  const pageTimes = await upsertPageProjection(transaction, input.application.replica, provenance);
  await reconcileBlockProjection(transaction, input.application.replica, provenance);
  await reconcileChecklistProjectionOutbox(transaction, input.application.replica, input.application.actor);
  await reconcilePageLinks(transaction, input.application.replica);
  const targetBlockId = input.application.targetBlockId &&
    input.application.replica.blocks.some((block) => block.id === input.application.targetBlockId)
    ? input.application.targetBlockId
    : null;
  const rows = await transaction<readonly PageOperationRecord[]>`
    INSERT INTO block_operations (
      id, page_id, target_block_id, operation_type,
      actor_kind, actor_session_id, actor_event_id, actor_user_id,
      idempotency_key, expected_version, result_version, payload_json, reason
    ) VALUES (
      ${input.operationId}, ${pageId}, ${targetBlockId},
      ${input.application.operationType}, ${input.application.actor.actorKind},
      ${input.application.actor.actorSessionId ?? null}, ${eventId},
      ${input.application.actor.actorUserId ?? null}, ${input.application.idempotencyKey},
      ${input.application.expectedVersion}, ${input.application.resultVersion},
      ${transaction.json(input.application.payload)}::jsonb, ${input.application.reason}
    ) RETURNING *
  `;
  const operation = rows[0];
  if (!operation) throw new Error("block operation insert returned no row");
  return {
    operation,
    pageCreatedAt: pageTimes.created_at,
    pageUpdatedAt: pageTimes.updated_at,
    idempotent: false,
  };
}

function assertMutationPageId(input: CommitPageMutationInput): void {
  const pageId = requirePageDocumentName(input.documentName);
  if (input.application.replica.page.id !== pageId) {
    throw new Error(`page id mismatch: document ${pageId}, replica ${input.application.replica.page.id}`);
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

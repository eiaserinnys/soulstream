import type { LiveDbSqlResolver, LivePostgresSql } from "../runtime/live_db_sql.js";
import { createPostgresQueryAdapter, type PostgresQuerySql } from "../runtime/postgres_query_adapter.js";
import type { PageYjsReplica } from "../page/page_yjs_model.js";

export const PLANNER_STARRED_TASK_ORDER_LOCK = "planner-starred-task-order";

type TransactionalLiveSql = LivePostgresSql & {
  readonly array: (values: readonly unknown[]) => unknown;
  readonly begin: <T>(callback: (transaction: LivePostgresSql) => Promise<T>) => Promise<T>;
};

export class PlannerStarredTaskMembershipConflictError extends Error {
  readonly code = "PLANNER_STARRED_TASK_NOT_ACTIVE";
}

export interface MoveStarredTaskResult {
  pageVersion: number;
  changed: boolean;
}

export interface PlannerStarredTaskOrderWriter {
  moveStarredTask(input: { pageId: string; beforePageId: string | null }): Promise<MoveStarredTaskResult>;
}

export async function syncStarredTaskOrderProjection(
  sql: PostgresQuerySql,
  replica: PageYjsReplica,
): Promise<void> {
  const pageId = replica.page.id;
  const shouldBeMember = isStarredTaskOrderMember(replica);
  const current = await hasOrderMembership(sql, pageId);
  if (current === shouldBeMember) return;

  await lockStarredTaskOrder(sql);
  if (await hasOrderMembership(sql, pageId) === shouldBeMember) return;

  if (!shouldBeMember) {
    await sql`DELETE FROM planner_starred_task_order WHERE page_id = ${pageId}`;
    return;
  }

  await sql`
    INSERT INTO planner_starred_task_order (page_id, position)
    SELECT ${pageId}, COALESCE(MAX(position) + 1, 0)
    FROM planner_starred_task_order
  `;
}

export function isStarredTaskOrderMember(replica: PageYjsReplica): boolean {
  if (
    replica.page.archived
    || replica.page.dailyDate !== null
    || replica.page.metadata.starred !== true
  ) return false;

  return replica.blocks.some((block) => {
    if (
      (block.type !== "task_ref" && block.type !== "runbook_ref")
      || block.properties.primary !== true
    ) return false;
    const identity = block.type === "task_ref"
      ? block.properties.taskId
      : block.properties.runbookId;
    return typeof identity === "string" && identity.trim().length > 0;
  });
}

export async function lockStarredTaskOrder(sql: PostgresQuerySql): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${PLANNER_STARRED_TASK_ORDER_LOCK}, 0))`;
}

export async function moveStarredTaskOrder(
  resolver: LiveDbSqlResolver,
  input: { pageId: string; beforePageId: string | null },
): Promise<MoveStarredTaskResult> {
  const sql = await resolver.resolveSql() as TransactionalLiveSql;
  return await sql.begin(async (transaction) => {
    const tx = createPostgresQueryAdapter(transaction as TransactionalLiveSql);
    await lockStarredTaskOrder(tx);

    const requestedIds = input.beforePageId === null
      ? [input.pageId]
      : [input.pageId, input.beforePageId];
    const activeRows = await tx<readonly { page_id: string; version: number }[]>`
      SELECT ordering.page_id, page.version
      FROM planner_starred_task_order ordering
      JOIN pages page ON page.id = ordering.page_id
      WHERE ordering.page_id = ANY(${tx.array(requestedIds)}::text[])
        AND page.archived = FALSE
        AND page.daily_date IS NULL
        AND COALESCE((page.metadata->>'starred')::boolean, FALSE)
        AND EXISTS (
          SELECT 1
          FROM blocks block
          WHERE block.page_id = page.id
            AND block.block_type IN ('task_ref', 'runbook_ref')
            AND COALESCE((block.properties->>'primary')::boolean, FALSE)
            AND NULLIF(BTRIM(CASE block.block_type
              WHEN 'task_ref' THEN block.properties->>'taskId'
              WHEN 'runbook_ref' THEN block.properties->>'runbookId'
            END), '') IS NOT NULL
        )
    `;
    const source = activeRows.find((row) => row.page_id === input.pageId);
    if (!source) throw new PlannerStarredTaskMembershipConflictError("source is not an active starred task");
    if (input.beforePageId !== null && !activeRows.some((row) => row.page_id === input.beforePageId)) {
      throw new PlannerStarredTaskMembershipConflictError("target is not an active starred task");
    }

    const orderedRows = await tx<readonly { page_id: string }[]>`
      SELECT ordering.page_id
      FROM planner_starred_task_order ordering
      JOIN pages page ON page.id = ordering.page_id
      WHERE page.archived = FALSE
        AND page.daily_date IS NULL
        AND COALESCE((page.metadata->>'starred')::boolean, FALSE)
        AND EXISTS (
          SELECT 1
          FROM blocks block
          WHERE block.page_id = page.id
            AND block.block_type IN ('task_ref', 'runbook_ref')
            AND COALESCE((block.properties->>'primary')::boolean, FALSE)
            AND NULLIF(BTRIM(CASE block.block_type
              WHEN 'task_ref' THEN block.properties->>'taskId'
              WHEN 'runbook_ref' THEN block.properties->>'runbookId'
            END), '') IS NOT NULL
        )
      ORDER BY ordering.position, ordering.page_id
    `;
    const currentIds = orderedRows.map((row) => row.page_id);
    const sourceIndex = currentIds.indexOf(input.pageId);
    const remainingIds = currentIds.filter((pageId) => pageId !== input.pageId);
    const destination = input.beforePageId === null
      ? remainingIds.length
      : remainingIds.indexOf(input.beforePageId);
    if (sourceIndex < 0 || destination < 0) {
      throw new PlannerStarredTaskMembershipConflictError("starred task membership changed");
    }

    const nextIds = [...remainingIds];
    nextIds.splice(destination, 0, input.pageId);
    const changed = nextIds.some((pageId, index) => pageId !== currentIds[index]);
    if (changed) {
      await tx`
        WITH ordered AS (
          SELECT page_id, ordinality - 1 AS position
          FROM unnest(${tx.array(nextIds)}::text[]) WITH ORDINALITY AS item(page_id, ordinality)
        )
        UPDATE planner_starred_task_order target
        SET position = ordered.position
        FROM ordered
        WHERE target.page_id = ordered.page_id
      `;
    }
    return { pageVersion: source.version, changed };
  });
}

async function hasOrderMembership(sql: PostgresQuerySql, pageId: string): Promise<boolean> {
  const rows = await sql<readonly { exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM planner_starred_task_order WHERE page_id = ${pageId}
    ) AS exists
  `;
  return rows[0]?.exists === true;
}

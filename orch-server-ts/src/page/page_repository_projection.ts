import { Buffer } from "node:buffer";

import type { PageYjsReplica } from "./page_yjs_model.js";

export type PageQuerySql = {
  <T extends readonly Record<string, unknown>[] = readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  readonly json: (value: unknown) => unknown;
  readonly array: (values: readonly unknown[]) => unknown;
};

export interface MutationProvenance {
  actorSessionId: string | null;
  eventId: number | null;
}

export async function storePageDocument(
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

export async function upsertPageProjection(
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

export async function reconcileBlockProjection(
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

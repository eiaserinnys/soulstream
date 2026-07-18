import { createHash } from "node:crypto";

import type { PageActorKind } from "@soulstream/page-model";

import type { PageYjsReplica } from "./page_yjs_model.js";

export interface ChecklistOutboxSql {
  <T extends readonly Record<string, unknown>[] = readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  readonly json: (value: unknown) => unknown;
  readonly array: (values: readonly unknown[]) => unknown;
}

export interface ChecklistOutboxActor {
  actorKind: PageActorKind;
  actorSessionId?: string | null;
  actorUserId?: string | null;
}

/** Coalesced SQL-only ingress. Network and Task work belongs to the worker reconciler. */
export async function reconcileChecklistProjectionOutbox(
  sql: ChecklistOutboxSql,
  replica: PageYjsReplica,
  actor?: ChecklistOutboxActor,
): Promise<void> {
  const checklists = replica.blocks.filter((block) => block.type === "checklist");
  const actorKind = actor?.actorKind ?? "system";
  const actorSessionId = actor?.actorSessionId ?? null;
  const actorUserId = actor?.actorUserId ?? null;

  if (checklists.length > 0) {
    const incoming = checklists.map((block) => ({
      block_id: block.id,
      page_id: replica.page.id,
      source_hash: checklistSourceHash(block.text, block.properties),
    }));
    await sql`
      WITH incoming AS (
        SELECT block_id, page_id, source_hash
        FROM jsonb_to_recordset(${sql.json(incoming)}::jsonb)
          AS row(block_id TEXT, page_id TEXT, source_hash TEXT)
      )
      INSERT INTO checklist_task_projection_outbox (
        block_id, page_id, source_hash,
        actor_kind, actor_session_id, actor_user_id,
        routing_session_id,
        attempts, last_error, next_retry_at,
        lease_owner_node_id, lease_expires_at, updated_at
      )
      SELECT
        incoming.block_id, incoming.page_id, incoming.source_hash,
        ${actorKind}, ${actorSessionId}, ${actorUserId},
        ${actorSessionId},
        0, NULL, NOW(), NULL, NULL, NOW()
      FROM incoming
      ON CONFLICT (block_id) DO UPDATE
      SET page_id = EXCLUDED.page_id,
          source_hash = EXCLUDED.source_hash,
          actor_kind = EXCLUDED.actor_kind,
          actor_session_id = EXCLUDED.actor_session_id,
          actor_user_id = EXCLUDED.actor_user_id,
          routing_session_id = EXCLUDED.actor_session_id,
          attempts = 0,
          last_error = NULL,
          next_retry_at = NOW(),
          lease_owner_node_id = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
      WHERE checklist_task_projection_outbox.page_id IS DISTINCT FROM EXCLUDED.page_id
         OR checklist_task_projection_outbox.source_hash IS DISTINCT FROM EXCLUDED.source_hash
    `;
  }

  const checklistIds = checklists.map((block) => block.id);
  if (checklistIds.length === 0) {
    await markMissingAsArchived(sql, replica.page.id, {
      actorKind,
      actorSessionId,
      actorUserId,
    });
  } else {
    await sql`
      UPDATE checklist_task_projection_outbox
      SET source_hash = 'archive:' || block_id,
      actor_kind = ${actorKind},
      actor_session_id = ${actorSessionId},
      actor_user_id = ${actorUserId},
      routing_session_id = ${actorSessionId},
          attempts = 0,
          last_error = NULL,
          next_retry_at = NOW(),
          lease_owner_node_id = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
      WHERE page_id = ${replica.page.id}
        AND block_id <> ALL(${sql.array(checklistIds)})
        AND source_hash IS DISTINCT FROM 'archive:' || block_id
    `;
  }
}

async function markMissingAsArchived(
  sql: ChecklistOutboxSql,
  pageId: string,
  actor: Required<ChecklistOutboxActor>,
): Promise<void> {
  await sql`
    UPDATE checklist_task_projection_outbox
    SET source_hash = 'archive:' || block_id,
        actor_kind = ${actor.actorKind},
        actor_session_id = ${actor.actorSessionId},
        actor_user_id = ${actor.actorUserId},
        routing_session_id = ${actor.actorSessionId},
        attempts = 0,
        last_error = NULL,
        next_retry_at = NOW(),
        lease_owner_node_id = NULL,
        lease_expires_at = NULL,
        updated_at = NOW()
    WHERE page_id = ${pageId}
      AND source_hash IS DISTINCT FROM 'archive:' || block_id
  `;
}

function checklistSourceHash(text: string, properties: Record<string, unknown>): string {
  const value = JSON.stringify([text, stable(properties)]);
  return `reconcile:${createHash("sha256").update(value).digest("hex")}`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stable(nested)]),
  );
}

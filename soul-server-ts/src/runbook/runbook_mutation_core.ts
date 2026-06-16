import { randomUUID } from "node:crypto";

import { generateKeyBetween } from "@soulstream/fractional-position";

import type { RepositorySql } from "../db/repositories/repository_helpers.js";
import type {
  RunbookItemStatus,
  RunbookOperationRow,
  RunbookOperationTargetKind,
  RunbookSnapshot,
} from "../db/session_db_types.js";

import { RunbookVersionConflict } from "./runbook_models.js";
import { resolveItemPositionTx } from "./runbook_position_queries.js";
import type { RunbookRepository } from "./runbook_repository.js";
import type {
  RunbookActorParams,
  RunbookBroadcasterPort,
  RunbookDbPort,
  RunbookMutationResult,
} from "./runbook_service_models.js";

export interface RunbookMutateParams {
  runbookId: string;
  targetKind: RunbookOperationTargetKind;
  targetId: string;
  operationType: string;
  actor: RunbookActorParams;
  payload: Record<string, unknown>;
  preflight?: (sql: RepositorySql) => Promise<void>;
  apply: (sql: RepositorySql, eventId: number) => Promise<void>;
  reason?: string | null;
  idempotencyKey?: string | null;
}

type RunbookEventParams = Omit<RunbookMutateParams, "preflight" | "apply"> & {
  operationId: string;
};

export class RunbookMutationCore {
  constructor(
    private readonly db: RunbookDbPort,
    private readonly repo: RunbookRepository,
    private readonly broadcaster?: RunbookBroadcasterPort,
  ) {}

  async mutate(params: RunbookMutateParams): Promise<RunbookMutationResult> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey);
    if (idempotent) return idempotent;

    let operation!: RunbookOperationRow;
    let eventId = 0;
    await this.repo.transaction(async (sql) => {
      await params.preflight?.(sql);
      const opId = randomUUID();
      eventId = await this.appendRunbookEvent(sql, { ...params, operationId: opId });
      await params.apply(sql, eventId);
      operation = await this.repo.appendOperationTx(sql, {
        id: opId,
        runbookId: params.runbookId,
        targetKind: params.targetKind,
        targetId: params.targetId,
        operationType: params.operationType,
        actorKind: params.actor.actorKind ?? "agent",
        actorSessionId: params.actor.actorSessionId,
        actorEventId: eventId,
        actorUserId: params.actor.actorUserId ?? null,
        idempotencyKey: params.idempotencyKey,
        payload: params.payload,
        reason: params.reason,
      });
    });

    const result = {
      snapshot: await this.requireSnapshot(params.runbookId),
      operation,
      eventId,
    };
    await this.broadcastMutation(params.actor.actorSessionId, result);
    return result;
  }

  async setItemStatus(params: RunbookActorParams & {
    itemId: string;
    expectedVersion: number;
    status: RunbookItemStatus;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey);
    if (idempotent) return idempotent;

    let runbookId = "";
    let operation!: RunbookOperationRow;
    let eventId = 0;
    await this.repo.transaction(async (sql) => {
      runbookId = await this.repo.getRunbookIdForItemTx(sql, params.itemId);
      await this.repo.assertItemVersionTx(sql, params.itemId, params.expectedVersion);
      const opId = randomUUID();
      eventId = await this.appendRunbookEvent(sql, {
        operationId: opId,
        runbookId,
        operationType: "set_item_status",
        targetKind: "item",
        targetId: params.itemId,
        actor: params,
        payload: { status: params.status },
        reason: params.reason,
        idempotencyKey: params.idempotencyKey,
      });
      await this.repo.setItemStatusTx(sql, {
        itemId: params.itemId,
        status: params.status,
        expectedVersion: params.expectedVersion,
        actorKind: params.actorKind ?? "agent",
        actorSessionId: params.actorSessionId,
        actorUserId: params.actorUserId ?? null,
        eventId,
      });
      operation = await this.repo.appendOperationTx(sql, {
        id: opId,
        runbookId,
        targetKind: "item",
        targetId: params.itemId,
        operationType: "set_item_status",
        actorKind: params.actorKind ?? "agent",
        actorSessionId: params.actorSessionId,
        actorEventId: eventId,
        actorUserId: params.actorUserId ?? null,
        idempotencyKey: params.idempotencyKey,
        payload: { status: params.status },
        reason: params.reason,
      });
    });

    const result = {
      snapshot: await this.requireSnapshot(runbookId),
      operation,
      eventId,
    };
    await this.broadcastMutation(params.actorSessionId, result);
    return result;
  }

  async moveItem(params: RunbookActorParams & {
    runbookId: string;
    itemId: string;
    expectedVersion: number;
    sectionId?: string | null;
    afterItemId?: string | null;
    beforeItemId?: string | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    let targetSectionId = params.sectionId ?? "";
    return await this.mutate({
      runbookId: params.runbookId,
      targetKind: "item",
      targetId: params.itemId,
      operationType: "move_runbook_item",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: {
        section_id: params.sectionId ?? null,
        after_item_id: params.afterItemId ?? null,
        before_item_id: params.beforeItemId ?? null,
      },
      preflight: async (sql) => {
        await this.repo.assertItemBelongsToRunbookTx(sql, params.itemId, params.runbookId);
        const item = await this.repo.getItemForUpdateTx(sql, params.itemId);
        const actualVersion = Number(item.version);
        if (actualVersion !== params.expectedVersion) {
          throw new RunbookVersionConflict(
            "item",
            params.itemId,
            params.expectedVersion,
            actualVersion,
          );
        }
        targetSectionId = params.sectionId ?? item.section_id;
        await this.repo.assertSectionBelongsToRunbookTx(sql, targetSectionId, params.runbookId);
      },
      apply: async (sql, eventId) => {
        const bounds = await resolveItemPositionTx(sql, targetSectionId, params);
        await this.repo.patchItemTx(
          sql,
          params.itemId,
          {
            section_id: targetSectionId,
            position_key: generateKeyBetween(bounds.lower, bounds.upper),
          },
          params.expectedVersion,
          params.actorSessionId,
          eventId,
        );
      },
    });
  }

  private async resolveIdempotent(
    idempotencyKey?: string | null,
  ): Promise<RunbookMutationResult | null> {
    if (!idempotencyKey) return null;
    const operation = await this.repo.getOperationByIdempotencyKey(idempotencyKey);
    if (!operation?.runbook_id) return null;
    return {
      snapshot: await this.requireSnapshot(operation.runbook_id),
      operation,
      eventId: operation.actor_event_id ?? 0,
      idempotent: true,
    };
  }

  private async appendRunbookEvent(
    sql: RepositorySql,
    params: RunbookEventParams,
  ): Promise<number> {
    return await this.db.appendEventTx(sql, {
      sessionId: params.actor.actorSessionId,
      eventType: "runbook_operation",
      payload: JSON.stringify({
        operation_id: params.operationId,
        operation_type: params.operationType,
        runbook_id: params.runbookId,
        target_kind: params.targetKind,
        target_id: params.targetId,
        payload: params.payload,
        reason: params.reason ?? null,
      }),
      searchableText: `runbook operation ${params.operationType}`,
      createdAt: new Date(),
      dedupeKey: params.idempotencyKey ?? null,
    });
  }

  private async requireSnapshot(runbookId: string): Promise<RunbookSnapshot> {
    const snapshot = await this.repo.getSnapshot(runbookId);
    if (!snapshot) throw new Error(`runbook not found: ${runbookId}`);
    return snapshot;
  }

  private async broadcastMutation(
    actorSessionId: string,
    result: RunbookMutationResult,
  ): Promise<void> {
    if (result.idempotent || !this.broadcaster) return;
    await this.broadcaster.emitRunbookUpdated(
      actorSessionId,
      result.snapshot.runbook.id,
      result.snapshot.runbook.board_item_id,
    );
  }
}

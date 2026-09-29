import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";

import { generateKeyBetween } from "@soulstream/fractional-position";

import type { RepositorySql } from "./task_types.js";
import type {
  ChecklistItemStatus,
  FolderOperationRow,
  FolderOperationActorKind,
  FolderOperationTargetKind,
  FolderSnapshot,
  FolderStatus,
} from "./task_types.js";

import { ChecklistVersionConflict } from "./task_models.js";
import { resolveItemPositionTx } from "./task_position_queries.js";
import type { ChecklistRepository } from "./task_repository.js";
import type {
  FolderActorParams,
  FolderBroadcasterPort,
  FolderDbPort,
  ChecklistMutationResult,
} from "./task_types.js";

export interface FolderMutateParams {
  folderId: string;
  targetKind: FolderOperationTargetKind;
  targetId: string;
  operationType: string;
  actor: FolderActorParams;
  payload: Record<string, unknown>;
  preflight?: (sql: RepositorySql) => Promise<void>;
  apply: (sql: RepositorySql, eventId: number | null) => Promise<void>;
  reason?: string | null;
  idempotencyKey?: string | null;
}

export interface SessionlessFolderMutateParams {
  folderId: string;
  targetKind: FolderOperationTargetKind;
  targetId: string;
  operationType: string;
  actor: {
    actorKind: Extract<FolderOperationActorKind, "user" | "system" | "llm">;
    actorSessionId: null;
    actorUserId?: string | null;
  };
  payload: Record<string, unknown>;
  apply: (sql: RepositorySql) => Promise<void>;
  reason?: string | null;
  idempotencyKey?: string | null;
}

type FolderEventParams = Omit<FolderMutateParams, "preflight" | "apply"> & {
  operationId: string;
};

export class ChecklistMutationCore {
  constructor(
    private readonly db: FolderDbPort,
    private readonly repo: ChecklistRepository,
    private readonly broadcaster?: FolderBroadcasterPort,
  ) {}

  async mutate(params: FolderMutateParams): Promise<ChecklistMutationResult> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey, params);
    if (idempotent) return idempotent;

    let operation!: FolderOperationRow;
    let eventId: number | null = null;
    await this.repo.transaction(async (sql) => {
      await params.preflight?.(sql);
      const opId = randomUUID();
      eventId = await this.appendFolderEventIfPresent(
        sql,
        { ...params, operationId: opId },
      );
      await params.apply(sql, eventId);
      operation = await this.repo.appendOperationTx(sql, {
        id: opId,
        folderId: params.folderId,
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
      snapshot: await this.requireSnapshot(params.folderId),
      operation,
      eventId: eventId ?? 0,
    };
    await this.broadcastMutation(params.actor.actorSessionId, result);
    return result;
  }

  async mutateWithoutSession(
    params: SessionlessFolderMutateParams,
  ): Promise<ChecklistMutationResult> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey, params);
    if (idempotent) return idempotent;

    let operation!: FolderOperationRow;
    await this.repo.transaction(async (sql) => {
      const operationId = randomUUID();
      await params.apply(sql);
      operation = await this.repo.appendOperationTx(sql, {
        id: operationId,
        folderId: params.folderId,
        targetKind: params.targetKind,
        targetId: params.targetId,
        operationType: params.operationType,
        actorKind: params.actor.actorKind,
        actorSessionId: null,
        actorEventId: null,
        actorUserId: params.actor.actorUserId ?? null,
        idempotencyKey: params.idempotencyKey,
        payload: params.payload,
        reason: params.reason,
      });
    });
    return {
      snapshot: await this.requireSnapshot(params.folderId),
      operation,
      eventId: 0,
    };
  }

  async setItemStatus(params: FolderActorParams & {
    itemId: string;
    expectedVersion: number;
    status: ChecklistItemStatus;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ChecklistMutationResult> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey, { targetId: params.itemId, operationType: "set_checklist_item_status", payload: { status: params.status } });
    if (idempotent) return idempotent;

    let folderId = "";
    let operation!: FolderOperationRow;
    let eventId: number | null = null;
    let shouldNotifyHandoff = false;
    await this.repo.transaction(async (sql) => {
      folderId = await this.repo.getFolderIdForItemTx(sql, params.itemId);
      const item = await this.repo.getItemForUpdateTx(sql, params.itemId);
      const actualVersion = Number(item.version);
      if (actualVersion !== params.expectedVersion) {
        throw new ChecklistVersionConflict(
          "item",
          params.itemId,
          params.expectedVersion,
          actualVersion,
        );
      }
      shouldNotifyHandoff =
        params.actorKind === "user" &&
        isTerminalHandoffStatus(params.status) &&
        item.status !== params.status;
      const opId = randomUUID();
      eventId = await this.appendFolderEventIfPresent(sql, {
        operationId: opId,
        folderId,
        operationType: "set_checklist_item_status",
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
        folderId,
        targetKind: "item",
        targetId: params.itemId,
        operationType: "set_checklist_item_status",
        actorKind: params.actorKind ?? "agent",
        actorSessionId: params.actorSessionId,
        actorEventId: eventId,
        actorUserId: params.actorUserId ?? null,
        idempotencyKey: params.idempotencyKey,
        payload: { status: params.status },
        reason: params.reason,
      });
    });

    const result: ChecklistMutationResult = {
      snapshot: await this.requireSnapshot(folderId),
      operation,
      eventId: eventId ?? 0,
    };
    await this.broadcastMutation(params.actorSessionId, result);
    if (shouldNotifyHandoff) {
      result.handoff = this.handoffEvent(result);
    }
    return result;
  }

  async setFolderStatus(params: FolderActorParams & {
    folderId: string;
    expectedVersion: number;
    status: FolderStatus;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ChecklistMutationResult> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey, { folderId: params.folderId, targetId: params.folderId, operationType: "set_folder_status", payload: { status: params.status } });
    if (idempotent) return idempotent;

    let operation!: FolderOperationRow;
    let eventId: number | null = null;
    await this.repo.transaction(async (sql) => {
      const folder = await this.repo.getFolderForUpdateTx(sql, params.folderId);
      const actualVersion = Number(folder.version);
      if (actualVersion !== params.expectedVersion) {
        throw new ChecklistVersionConflict(
          "folder",
          params.folderId,
          params.expectedVersion,
          actualVersion,
        );
      }
      const opId = randomUUID();
      eventId = await this.appendFolderEventIfPresent(sql, {
        operationId: opId,
        folderId: params.folderId,
        operationType: "set_folder_status",
        targetKind: "folder",
        targetId: params.folderId,
        actor: params,
        payload: { status: params.status },
        reason: params.reason,
        idempotencyKey: params.idempotencyKey,
      });
      await this.repo.setFolderStatusTx(sql, {
        folderId: params.folderId,
        status: params.status,
        expectedVersion: params.expectedVersion,
        actorKind: params.actorKind ?? "agent",
        actorSessionId: params.actorSessionId,
        actorUserId: params.actorUserId ?? null,
        eventId,
      });
      operation = await this.repo.appendOperationTx(sql, {
        id: opId,
        folderId: params.folderId,
        targetKind: "folder",
        targetId: params.folderId,
        operationType: "set_folder_status",
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
      snapshot: await this.requireSnapshot(params.folderId),
      operation,
      eventId: eventId ?? 0,
    };
    await this.broadcastMutation(params.actorSessionId, result);
    return result;
  }

  async moveItem(params: FolderActorParams & {
    folderId: string;
    itemId: string;
    expectedVersion: number;
    sectionId?: string | null;
    afterItemId?: string | null;
    beforeItemId?: string | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ChecklistMutationResult> {
    let targetSectionId = params.sectionId ?? "";
    return await this.mutate({
      folderId: params.folderId,
      targetKind: "item",
      targetId: params.itemId,
      operationType: "move_checklist_item",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: {
        section_id: params.sectionId ?? null,
        after_item_id: params.afterItemId ?? null,
        before_item_id: params.beforeItemId ?? null,
      },
      preflight: async (sql) => {
        await this.repo.assertItemBelongsToFolderTx(sql, params.itemId, params.folderId);
        const item = await this.repo.getItemForUpdateTx(sql, params.itemId);
        const actualVersion = Number(item.version);
        if (actualVersion !== params.expectedVersion) {
          throw new ChecklistVersionConflict(
            "item",
            params.itemId,
            params.expectedVersion,
            actualVersion,
          );
        }
        targetSectionId = params.sectionId ?? item.section_id;
        await this.repo.assertSectionBelongsToFolderTx(sql, targetSectionId, params.folderId);
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
    idempotencyKey: string | null | undefined,
    expected: { folderId?: string; targetId: string; operationType: string; payload: Record<string, unknown> },
  ): Promise<ChecklistMutationResult | null> {
    if (!idempotencyKey) return null;
    const operation = await this.repo.getOperationByIdempotencyKey(idempotencyKey);
    if (!operation?.folder_id) return null;
    if ((expected.folderId && operation.folder_id !== expected.folderId)
      || operation.operation_type !== expected.operationType
      || (!expected.operationType.startsWith("create_") && operation.target_id !== expected.targetId)
      || !isDeepStrictEqual(operation.payload_json, JSON.parse(JSON.stringify(expected.payload)))) {
      throw Object.assign(new Error("Idempotency key belongs to a different request"), { statusCode: 409, code: "FOLDER_IDEMPOTENCY_CONFLICT" });
    }
    return {
      snapshot: await this.requireSnapshot(operation.folder_id),
      operation,
      eventId: operation.actor_event_id ?? 0,
      idempotent: true,
    };
  }

  private async appendFolderEvent(
    sql: RepositorySql,
    params: FolderEventParams,
    actorSessionId: string,
  ): Promise<number> {
    return await this.db.appendEventTx(sql, {
      sessionId: actorSessionId,
      eventType: "folder_operation",
      payload: JSON.stringify({
        operation_id: params.operationId,
        operation_type: params.operationType,
        folder_id: params.folderId,
        target_kind: params.targetKind,
        target_id: params.targetId,
        payload: params.payload,
        reason: params.reason ?? null,
      }),
      searchableText: `folder operation ${params.operationType}`,
      createdAt: new Date(),
      dedupeKey: params.idempotencyKey ?? null,
    });
  }

  private async appendFolderEventIfPresent(
    sql: RepositorySql,
    params: FolderEventParams,
  ): Promise<number | null> {
    const actorSessionId = params.actor.actorSessionId;
    if (actorSessionId === null) return null;
    return await this.appendFolderEvent(sql, params, actorSessionId);
  }

  private async requireSnapshot(folderId: string): Promise<FolderSnapshot> {
    const snapshot = await this.repo.getSnapshot(folderId);
    if (!snapshot) throw new Error(`folder not found: ${folderId}`);
    return snapshot;
  }

  private async broadcastMutation(
    actorSessionId: string | null,
    result: ChecklistMutationResult,
  ): Promise<void> {
    if (result.idempotent || !this.broadcaster) return;
    await this.broadcaster.emitFolderUpdated(
      result.snapshot.folder.id,
      actorSessionId,
      result.operation.target_kind === "folder",
    );
  }

  private handoffEvent(result: ChecklistMutationResult): ChecklistMutationResult["handoff"] {
    const item = result.snapshot.items.find(
      (candidate) => candidate.id === result.operation.target_id,
    );
    if (!item || !isTerminalHandoffStatus(item.status)) return undefined;
    return {
      folderId: result.snapshot.folder.id,
      folderName: result.snapshot.folder.name,
      itemId: item.id,
      itemTitle: item.title,
      status: item.status,
      operationId: result.operation.id,
      eventId: result.eventId,
    };
  }

}

function isTerminalHandoffStatus(
  status: ChecklistItemStatus,
): status is Extract<ChecklistItemStatus, "completed" | "cancelled"> {
  return status === "completed" || status === "cancelled";
}

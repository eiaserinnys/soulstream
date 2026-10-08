import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";

import { generateKeyBetween } from "@soulstream/fractional-position";

import type { RepositorySql } from "./card_types.js";
import type {
  CardStatus,
  FolderOperationRow,
  FolderOperationActorKind,
  FolderOperationTargetKind,
  FolderSnapshot,
  FolderStatus,
} from "./card_types.js";

import { CardVersionConflict } from "./card_models.js";

import type { CardRepository } from "./card_repository.js";
import type {
  FolderActorParams,
  FolderBroadcasterPort,
  FolderDbPort,
  CardMutationResult,
} from "./card_types.js";

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

export type CardOperationTxObserver = (
  sql: RepositorySql,
  operation: FolderOperationRow,
) => Promise<void>;

type FolderEventParams = Omit<FolderMutateParams, "preflight" | "apply"> & {
  operationId: string;
};

export class CardMutationCore {
  constructor(
    private readonly db: FolderDbPort,
    private readonly repo: CardRepository,
    private readonly broadcaster?: FolderBroadcasterPort,
    private readonly operationTxObserver?: CardOperationTxObserver,
  ) {}

  async mutate(params: FolderMutateParams): Promise<CardMutationResult> {
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
      if (operation.target_kind === "card") {
        await this.operationTxObserver?.(sql, operation);
      }
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
  ): Promise<CardMutationResult> {
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
      if (operation.target_kind === "card") {
        await this.operationTxObserver?.(sql, operation);
      }
    });
    return {
      snapshot: await this.requireSnapshot(params.folderId),
      operation,
      eventId: 0,
    };
  }

  async setFolderStatus(params: FolderActorParams & {
    folderId: string;
    expectedVersion: number;
    status: FolderStatus;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<CardMutationResult> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey, { folderId: params.folderId, targetId: params.folderId, operationType: "set_folder_status", payload: { status: params.status } });
    if (idempotent) return idempotent;

    let operation!: FolderOperationRow;
    let eventId: number | null = null;
    await this.repo.transaction(async (sql) => {
      const folder = await this.repo.getFolderForUpdateTx(sql, params.folderId);
      const actualVersion = Number(folder.version);
      if (actualVersion !== params.expectedVersion) {
        throw new CardVersionConflict(
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

  private async resolveIdempotent(
    idempotencyKey: string | null | undefined,
    expected: { folderId?: string; targetId: string; operationType: string; payload: Record<string, unknown> },
  ): Promise<CardMutationResult | null> {
    if (!idempotencyKey) return null;
    const operation = await this.repo.getOperationByIdempotencyKey(idempotencyKey);
    if (!operation?.folder_id) return null;
    const { claimed_assignee: _claim, ...requestPayload } = operation.payload_json;
    if ((expected.folderId && expected.operationType !== "move_card" && operation.folder_id !== expected.folderId)
      || operation.operation_type !== expected.operationType
      || (!expected.operationType.startsWith("create_") && operation.target_id !== expected.targetId)
      || !isDeepStrictEqual(requestPayload, JSON.parse(JSON.stringify(expected.payload)))) {
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
    result: CardMutationResult,
  ): Promise<void> {
    if (result.idempotent || !this.broadcaster) return;
    if (result.operation.target_kind === "card") {
      await this.broadcaster.emitCardUpdated?.(result.operation.target_id, result.snapshot.folder.id);
      return;
    }
    await this.broadcaster.emitFolderUpdated(
      result.snapshot.folder.id,
      actorSessionId,
      result.operation.target_kind === "folder",
    );
  }

}

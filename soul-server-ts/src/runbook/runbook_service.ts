import { randomUUID } from "node:crypto";

import { generateKeyBetween } from "@soulstream/fractional-position";

import type { AppendEventParams } from "../db/session_db.js";
import type { RepositorySql } from "../db/repositories/repository_helpers.js";
import type {
  RunbookItemStatus,
  RunbookOperationActorKind,
  RunbookOperationRow,
  RunbookOperationTargetKind,
  RunbookSnapshot,
} from "../db/session_db_types.js";

import { RunbookRepository } from "./runbook_repository.js";
import {
  assigneeToFields,
  type RunbookAssigneeInput,
} from "./runbook_models.js";
import {
  resolveItemPositionTx,
  resolveSectionPositionTx,
} from "./runbook_position_queries.js";

export interface RunbookDbPort {
  runbooks(): RunbookRepository;
  appendEventTx(sql: RepositorySql, params: AppendEventParams): Promise<number>;
}

export interface RunbookMutationResult {
  snapshot: RunbookSnapshot;
  operation: RunbookOperationRow;
  eventId: number;
  idempotent?: boolean;
}

interface ActorParams {
  actorKind?: RunbookOperationActorKind;
  actorSessionId: string;
  actorUserId?: string | null;
}

export class RunbookService {
  private readonly repo: RunbookRepository;

  constructor(private readonly db: RunbookDbPort) {
    this.repo = db.runbooks();
  }

  async getRunbook(runbookId: string): Promise<RunbookSnapshot | null> {
    return await this.repo.getSnapshot(runbookId);
  }

  async listMyTurnItems(params: { userId?: string | null; limit?: number } = {}) {
    return await this.repo.listMyTurnItems(params);
  }

  async listOperations(runbookId: string, limit?: number) {
    return await this.repo.listOperations(runbookId, limit);
  }

  async createRunbook(params: ActorParams & {
    runbookId?: string;
    boardItemId: string;
    title: string;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    const runbookId = params.runbookId ?? randomUUID();
    return await this.mutate({
      runbookId,
      targetKind: "runbook",
      targetId: runbookId,
      operationType: "create_runbook",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      payload: {
        board_item_id: params.boardItemId,
        title: params.title,
      },
      apply: async (sql, eventId) => {
        await this.repo.createRunbookTx(sql, {
          id: runbookId,
          boardItemId: params.boardItemId,
          title: params.title,
          createdSessionId: params.actorSessionId,
          createdEventId: eventId,
        });
      },
    });
  }

  async patchRunbook(params: ActorParams & {
    runbookId: string;
    expectedVersion: number;
    title?: string;
    archived?: boolean;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    return await this.mutate({
      runbookId: params.runbookId,
      targetKind: "runbook",
      targetId: params.runbookId,
      operationType: params.archived ? "archive_runbook" : "update_runbook",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: { title: params.title, archived: params.archived },
      preflight: (sql) =>
        this.repo.assertRunbookVersionTx(sql, params.runbookId, params.expectedVersion),
      apply: async (sql) => {
        await this.repo.patchRunbookTx(
          sql,
          params.runbookId,
          { title: params.title, archived: params.archived },
          params.expectedVersion,
        );
      },
    });
  }

  async createSection(params: ActorParams & {
    runbookId: string;
    title: string;
    sectionId?: string;
    assignee?: RunbookAssigneeInput | null;
    afterSectionId?: string | null;
    beforeSectionId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    const sectionId = params.sectionId ?? randomUUID();
    return await this.mutate({
      runbookId: params.runbookId,
      targetKind: "section",
      targetId: sectionId,
      operationType: "create_runbook_section",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      payload: {
        title: params.title,
        after_section_id: params.afterSectionId ?? null,
        before_section_id: params.beforeSectionId ?? null,
        assignee: params.assignee ?? null,
      },
      apply: async (sql, eventId) => {
        const bounds = await resolveSectionPositionTx(sql, params.runbookId, params);
        await this.repo.createSectionTx(sql, {
          id: sectionId,
          runbookId: params.runbookId,
          title: params.title,
          positionKey: generateKeyBetween(bounds.lower, bounds.upper),
          assignee: assigneeToFields(params.assignee),
          actorSessionId: params.actorSessionId,
          eventId,
        });
      },
    });
  }

  async patchSection(params: ActorParams & {
    runbookId: string;
    sectionId: string;
    expectedVersion: number;
    title?: string;
    archived?: boolean;
    assignee?: RunbookAssigneeInput | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    const assigneeFields =
      Object.prototype.hasOwnProperty.call(params, "assignee")
        ? assigneeToFields(params.assignee)
        : {};
    return await this.mutate({
      runbookId: params.runbookId,
      targetKind: "section",
      targetId: params.sectionId,
      operationType: params.archived ? "archive_runbook_section" : "update_runbook_section",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: {
        title: params.title,
        archived: params.archived,
        assignee: params.assignee ?? null,
      },
      preflight: async (sql) => {
        await this.repo.assertSectionBelongsToRunbookTx(sql, params.sectionId, params.runbookId);
        await this.repo.assertSectionVersionTx(sql, params.sectionId, params.expectedVersion);
      },
      apply: async (sql, eventId) => {
        await this.repo.patchSectionTx(
          sql,
          params.sectionId,
          { title: params.title, archived: params.archived, ...assigneeFields },
          params.expectedVersion,
          params.actorSessionId,
          eventId,
        );
      },
    });
  }

  async moveSection(params: ActorParams & {
    runbookId: string;
    sectionId: string;
    expectedVersion: number;
    afterSectionId?: string | null;
    beforeSectionId?: string | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    return await this.mutate({
      runbookId: params.runbookId,
      targetKind: "section",
      targetId: params.sectionId,
      operationType: "move_runbook_section",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: {
        after_section_id: params.afterSectionId ?? null,
        before_section_id: params.beforeSectionId ?? null,
      },
      preflight: async (sql) => {
        await this.repo.assertSectionBelongsToRunbookTx(sql, params.sectionId, params.runbookId);
        await this.repo.assertSectionVersionTx(sql, params.sectionId, params.expectedVersion);
      },
      apply: async (sql, eventId) => {
        const bounds = await resolveSectionPositionTx(sql, params.runbookId, params);
        await this.repo.patchSectionTx(
          sql,
          params.sectionId,
          { position_key: generateKeyBetween(bounds.lower, bounds.upper) },
          params.expectedVersion,
          params.actorSessionId,
          eventId,
        );
      },
    });
  }

  async createItem(params: ActorParams & {
    runbookId: string;
    sectionId: string;
    title: string;
    howTo?: string;
    itemId?: string;
    assignee?: RunbookAssigneeInput | null;
    afterItemId?: string | null;
    beforeItemId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    const itemId = params.itemId ?? randomUUID();
    return await this.mutate({
      runbookId: params.runbookId,
      targetKind: "item",
      targetId: itemId,
      operationType: "create_runbook_item",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      payload: {
        section_id: params.sectionId,
        title: params.title,
        how_to: params.howTo ?? "",
        assignee: params.assignee ?? null,
      },
      preflight: (sql) =>
        this.repo.assertSectionBelongsToRunbookTx(sql, params.sectionId, params.runbookId),
      apply: async (sql, eventId) => {
        const bounds = await resolveItemPositionTx(sql, params.sectionId, params);
        await this.repo.createItemTx(sql, {
          id: itemId,
          sectionId: params.sectionId,
          title: params.title,
          howTo: params.howTo ?? "",
          positionKey: generateKeyBetween(bounds.lower, bounds.upper),
          assignee: assigneeToFields(params.assignee),
          actorKind: params.actorKind ?? "agent",
          actorSessionId: params.actorSessionId,
          actorUserId: params.actorUserId ?? null,
          eventId,
        });
      },
    });
  }

  async patchItem(params: ActorParams & {
    runbookId: string;
    itemId: string;
    expectedVersion: number;
    title?: string;
    howTo?: string;
    archived?: boolean;
    assignee?: RunbookAssigneeInput | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    const assigneeFields =
      Object.prototype.hasOwnProperty.call(params, "assignee")
        ? assigneeToFields(params.assignee)
        : {};
    return await this.mutate({
      runbookId: params.runbookId,
      targetKind: "item",
      targetId: params.itemId,
      operationType: params.archived ? "archive_runbook_item" : "update_runbook_item",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: {
        title: params.title,
        how_to: params.howTo,
        archived: params.archived,
        assignee: params.assignee ?? null,
      },
      preflight: async (sql) => {
        await this.repo.assertItemBelongsToRunbookTx(sql, params.itemId, params.runbookId);
        await this.repo.assertItemVersionTx(sql, params.itemId, params.expectedVersion);
      },
      apply: async (sql, eventId) => {
        await this.repo.patchItemTx(
          sql,
          params.itemId,
          { title: params.title, how_to: params.howTo, archived: params.archived, ...assigneeFields },
          params.expectedVersion,
          params.actorSessionId,
          eventId,
        );
      },
    });
  }

  async setItemStatus(params: ActorParams & {
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
    return {
      snapshot: await this.requireSnapshot(runbookId),
      operation,
      eventId,
    };
  }

  private async mutate(params: {
    runbookId: string;
    targetKind: RunbookOperationTargetKind;
    targetId: string;
    operationType: string;
    actor: ActorParams;
    payload: Record<string, unknown>;
    preflight?: (sql: RepositorySql) => Promise<void>;
    apply: (sql: RepositorySql, eventId: number) => Promise<void>;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
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
    return {
      snapshot: await this.requireSnapshot(params.runbookId),
      operation,
      eventId,
    };
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
    params: {
      operationId: string;
      runbookId: string;
      operationType: string;
      targetKind: RunbookOperationTargetKind;
      targetId: string;
      actor: ActorParams;
      payload: Record<string, unknown>;
      reason?: string | null;
      idempotencyKey?: string | null;
    },
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
}

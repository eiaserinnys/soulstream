import { randomUUID } from "node:crypto";

import { generateKeyBetween } from "@soulstream/fractional-position";

import type { RunbookItemStatus, RunbookSnapshot, RunbookStatus } from "../db/session_db_types.js";

import { assigneeToFields, type RunbookAssigneeInput } from "./runbook_models.js";
import { RunbookMutationCore } from "./runbook_mutation_core.js";
import { enrollRunbookCreatorSession, type RunbookCreatorBoardItemMoverPort, type RunbookCreatorEnrollmentLoggerPort } from "./runbook_creator_enrollment.js";
import { itemPatchOperationType, runbookPatchOperationType, sectionPatchOperationType } from "./runbook_operation_types.js";
import { resolveItemPositionTx, resolveSectionPositionTx } from "./runbook_position_queries.js";
import type { RunbookRepository } from "./runbook_repository.js";
import {
  removeRunbookBoardItemIfUnlinked,
  resolveRunbookIdempotent,
  type RunbookBoardYjsPort,
  updateRunbookBoardItemTitle,
  upsertRunbookBoardItem,
} from "./runbook_board_items.js";
import { mutateRunbookCreation } from "./runbook_creation_mutation.js";
import type {
  RunbookActorParams,
  RunbookBroadcasterPort,
  RunbookDbPort,
  RunbookHandoffNotifierPort,
  RunbookMutationResult,
} from "./runbook_service_models.js";

export type {
  RunbookActorParams,
  RunbookBroadcasterPort,
  RunbookDbPort,
  RunbookMutationResult,
} from "./runbook_service_models.js";

export class RunbookService {
  private readonly repo: RunbookRepository;
  private readonly core: RunbookMutationCore;

  constructor(
    private readonly db: RunbookDbPort,
    private readonly broadcaster: RunbookBroadcasterPort | undefined,
    private readonly boardYjsService: RunbookBoardYjsPort,
    handoffNotifier?: RunbookHandoffNotifierPort,
    private readonly creatorBoardItemMover?: RunbookCreatorBoardItemMoverPort,
    private readonly logger?: RunbookCreatorEnrollmentLoggerPort,
  ) {
    this.repo = db.runbooks();
    this.core = new RunbookMutationCore(db, this.repo, broadcaster, handoffNotifier);
  }

  async getRunbook(runbookId: string): Promise<RunbookSnapshot | null> {
    return await this.repo.getSnapshot(runbookId);
  }

  async listRunbooks(params: {
    folderId: string;
    includeArchived?: boolean;
    limit?: number;
  }) {
    return await this.repo.listRunbooks(params);
  }

  async listMyTurnItems(params: { userId?: string | null; limit?: number } = {}) {
    return await this.repo.listMyTurnItems(params);
  }

  async listOperations(runbookId: string, limit?: number) {
    return await this.repo.listOperations(runbookId, limit);
  }

  async createRunbook(params: Omit<RunbookActorParams, "actorSessionId"> & {
    actorSessionId: string | null;
    runbookId?: string;
    folderId: string;
    title: string;
    x?: number;
    y?: number;
    idempotencyKey?: string | null;
    enrollCreator?: boolean;
  }): Promise<RunbookMutationResult> {
    const runbookId = params.runbookId ?? randomUUID();
    const boardItemId = `runbook:${runbookId}`;
    const x = params.x ?? 0;
    const y = params.y ?? 0;
    const idempotent = await resolveRunbookIdempotent(this.repo, params.idempotencyKey);
    if (idempotent) return idempotent;
    await upsertRunbookBoardItem(this.boardYjsService, {
      folderId: params.folderId,
      boardItemId,
      runbookId,
      title: params.title,
      x,
      y,
    });
    let result: RunbookMutationResult;
    try {
      result = await mutateRunbookCreation(this.core, this.repo, {
        ...params,
        runbookId,
        boardItemId,
        x,
        y,
      });
    } catch (err) {
      await removeRunbookBoardItemIfUnlinked(this.repo, this.boardYjsService, {
        folderId: params.folderId,
        boardItemId,
        runbookId,
      }).catch(() => undefined);
      throw err;
    }
    const creatorEnrolled = params.enrollCreator === false || params.actorSessionId === null
      ? false
      : (await enrollRunbookCreatorSession({
          mover: this.creatorBoardItemMover, logger: this.logger,
          actorSessionId: params.actorSessionId, runbookId,
        })) ?? false;
    if (!creatorEnrolled) await this.broadcastCatalog();
    return result;
  }

  async patchRunbook(params: RunbookActorParams & {
    runbookId: string;
    expectedVersion: number;
    title?: string;
    archived?: boolean;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    const result = await this.core.mutate({
      runbookId: params.runbookId,
      targetKind: "runbook",
      targetId: params.runbookId,
      operationType: runbookPatchOperationType(params.archived),
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
    if (params.title !== undefined) {
      await updateRunbookBoardItemTitle(
        this.repo,
        this.boardYjsService,
        params.runbookId,
        params.title,
      );
    }
    if (params.title !== undefined || params.archived !== undefined) {
      await this.broadcastCatalog();
    }
    return result;
  }

  async setRunbookStatus(params: RunbookActorParams & {
    runbookId: string;
    expectedVersion: number;
    status: RunbookStatus;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    return await this.core.setRunbookStatus(params);
  }

  private async broadcastCatalog(): Promise<void> {
    if (!this.broadcaster?.emitCatalogUpdated) return;
    await this.broadcaster.emitCatalogUpdated(await this.db.getCatalog());
  }

  async createSection(params: RunbookActorParams & {
    runbookId: string;
    title: string;
    sectionId?: string;
    assignee?: RunbookAssigneeInput | null;
    afterSectionId?: string | null;
    beforeSectionId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    const sectionId = params.sectionId ?? randomUUID();
    return await this.core.mutate({
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

  async patchSection(params: RunbookActorParams & {
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
    return await this.core.mutate({
      runbookId: params.runbookId,
      targetKind: "section",
      targetId: params.sectionId,
      operationType: sectionPatchOperationType(params.archived),
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

  async setSectionAssignee(params: RunbookActorParams & {
    runbookId: string;
    sectionId: string;
    expectedVersion: number;
    assignee?: RunbookAssigneeInput | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    return await this.core.mutate({
      runbookId: params.runbookId,
      targetKind: "section",
      targetId: params.sectionId,
      operationType: "set_runbook_section_assignee",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: { assignee: params.assignee ?? null },
      preflight: async (sql) => {
        await this.repo.assertSectionBelongsToRunbookTx(sql, params.sectionId, params.runbookId);
        await this.repo.assertSectionVersionTx(sql, params.sectionId, params.expectedVersion);
      },
      apply: async (sql, eventId) => {
        await this.repo.patchSectionTx(
          sql,
          params.sectionId,
          assigneeToFields(params.assignee),
          params.expectedVersion,
          params.actorSessionId,
          eventId,
        );
      },
    });
  }

  async moveSection(params: RunbookActorParams & {
    runbookId: string;
    sectionId: string;
    expectedVersion: number;
    afterSectionId?: string | null;
    beforeSectionId?: string | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    return await this.core.mutate({
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

  async createItem(params: RunbookActorParams & {
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
    return await this.core.mutate({
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

  async patchItem(params: RunbookActorParams & {
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
    return await this.core.mutate({
      runbookId: params.runbookId,
      targetKind: "item",
      targetId: params.itemId,
      operationType: itemPatchOperationType(params.archived),
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

  async setItemAssignee(params: RunbookActorParams & {
    runbookId: string;
    itemId: string;
    expectedVersion: number;
    assignee?: RunbookAssigneeInput | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    return await this.core.mutate({
      runbookId: params.runbookId,
      targetKind: "item",
      targetId: params.itemId,
      operationType: "set_runbook_item_assignee",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: { assignee: params.assignee ?? null },
      preflight: async (sql) => {
        await this.repo.assertItemBelongsToRunbookTx(sql, params.itemId, params.runbookId);
        await this.repo.assertItemVersionTx(sql, params.itemId, params.expectedVersion);
      },
      apply: async (sql, eventId) => {
        await this.repo.patchItemTx(
          sql,
          params.itemId,
          assigneeToFields(params.assignee),
          params.expectedVersion,
          params.actorSessionId,
          eventId,
        );
      },
    });
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
    return await this.core.moveItem(params);
  }

  async setItemStatus(params: RunbookActorParams & {
    itemId: string;
    expectedVersion: number;
    status: RunbookItemStatus;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<RunbookMutationResult> {
    return await this.core.setItemStatus(params);
  }
}

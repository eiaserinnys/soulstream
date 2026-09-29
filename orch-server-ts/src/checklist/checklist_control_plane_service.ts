import { randomUUID } from "node:crypto";

import { generateKeyBetween } from "@soulstream/fractional-position";

import { assigneeToFields, assertFolderPatchHasFields, type ChecklistAssigneeInput } from "./control_plane/checklist_models.js";
import { ChecklistMutationCore } from "./control_plane/checklist_mutation_core.js";
import { itemPatchOperationType, sectionPatchOperationType } from "./control_plane/checklist_operation_types.js";
import { resolveItemPositionTx, resolveSectionPositionTx } from "./control_plane/checklist_position_queries.js";
import { ChecklistRepository } from "./control_plane/checklist_repository.js";
import type {
  SqlClient,
  FolderActorParams,
  FolderBroadcasterPort,
  FolderDbPort,
  ChecklistItemStatus,
  ChecklistMutationResult,
  FolderStatus,
} from "./control_plane/checklist_types.js";

export class ChecklistControlPlaneService {
  private readonly repo: ChecklistRepository;
  private readonly core: ChecklistMutationCore;

  constructor(sql: SqlClient, db: FolderDbPort, broadcaster?: FolderBroadcasterPort) {
    this.repo = new ChecklistRepository(sql);
    this.core = new ChecklistMutationCore(db, this.repo, broadcaster);
  }

  async getFolder(folderId: string) {
    return await this.repo.getSnapshot(folderId);
  }

  async listFolders(params: { folderId: string | null; includeArchived?: boolean; limit?: number; offset?: number }) {
    return await this.repo.listFolders(params);
  }

  async listMyTurnItems(params: { userId?: string | null; limit?: number } = {}) {
    return await this.repo.listMyTurnItems(params);
  }

  async listOperations(folderId: string, limit?: number, offset?: number) {
    return await this.repo.listOperations(folderId, limit, offset);
  }

  async listAgentSubscriberSessionIds(folderId: string): Promise<string[]> {
    return await this.repo.listAgentSubscriberSessionIds(folderId);
  }

  async setFolderStatus(params: FolderActorParams & {
    folderId: string;
    expectedVersion: number;
    status: FolderStatus;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ChecklistMutationResult> {
    return await this.core.setFolderStatus(params);
  }

  async setFolderChecklistEnabled(params: FolderActorParams & {
    folderId: string;
    checklistEnabled: boolean;
    expectedVersion: number;
    idempotencyKey?: string | null;
  }): Promise<ChecklistMutationResult> {
    return await this.core.mutate({
      folderId: params.folderId,
      targetKind: "folder",
      targetId: params.folderId,
      operationType: "set_folder_checklist_enabled",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      payload: { checklist_enabled: params.checklistEnabled },
      apply: async (sql) => {
        await this.repo.patchFolderTx(sql, params.folderId,
          { checklist_enabled: params.checklistEnabled }, params.expectedVersion);
      },
    });
  }

  async createSection(params: FolderActorParams & {
    folderId: string;
    title: string;
    sectionId?: string;
    assignee?: ChecklistAssigneeInput | null;
    afterSectionId?: string | null;
    beforeSectionId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ChecklistMutationResult> {
    const sectionId = params.sectionId ?? randomUUID();
    return await this.core.mutate({
      folderId: params.folderId,
      targetKind: "section",
      targetId: sectionId,
      operationType: "create_checklist_section",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      payload: {
        title: params.title,
        after_section_id: params.afterSectionId ?? null,
        before_section_id: params.beforeSectionId ?? null,
        assignee: params.assignee ?? null,
      },
      apply: async (sql, eventId) => {
        const bounds = await resolveSectionPositionTx(sql, params.folderId, params);
        await this.repo.createSectionTx(sql, {
          id: sectionId,
          folderId: params.folderId,
          title: params.title,
          positionKey: generateKeyBetween(bounds.lower, bounds.upper),
          assignee: assigneeToFields(params.assignee),
          actorSessionId: params.actorSessionId,
          eventId,
        });
      },
    });
  }

  async patchSection(params: FolderActorParams & {
    folderId: string;
    sectionId: string;
    expectedVersion: number;
    title?: string;
    archived?: boolean;
    assignee?: ChecklistAssigneeInput | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ChecklistMutationResult> {
    const assigneeFields = Object.prototype.hasOwnProperty.call(params, "assignee")
      ? assigneeToFields(params.assignee)
      : {};
    assertFolderPatchHasFields("section", {
      title: params.title,
      archived: params.archived,
      ...assigneeFields,
    });
    return await this.core.mutate({
      folderId: params.folderId,
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
        await this.repo.assertSectionBelongsToFolderTx(sql, params.sectionId, params.folderId);
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

  async setSectionAssignee(params: FolderActorParams & {
    folderId: string;
    sectionId: string;
    expectedVersion: number;
    assignee?: ChecklistAssigneeInput | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ChecklistMutationResult> {
    return await this.core.mutate({
      folderId: params.folderId,
      targetKind: "section",
      targetId: params.sectionId,
      operationType: "set_checklist_section_assignee",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: { assignee: params.assignee ?? null },
      preflight: async (sql) => {
        await this.repo.assertSectionBelongsToFolderTx(sql, params.sectionId, params.folderId);
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

  async moveSection(params: FolderActorParams & {
    folderId: string;
    sectionId: string;
    expectedVersion: number;
    afterSectionId?: string | null;
    beforeSectionId?: string | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ChecklistMutationResult> {
    return await this.core.mutate({
      folderId: params.folderId,
      targetKind: "section",
      targetId: params.sectionId,
      operationType: "move_checklist_section",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: {
        after_section_id: params.afterSectionId ?? null,
        before_section_id: params.beforeSectionId ?? null,
      },
      preflight: async (sql) => {
        await this.repo.assertSectionBelongsToFolderTx(sql, params.sectionId, params.folderId);
        await this.repo.assertSectionVersionTx(sql, params.sectionId, params.expectedVersion);
      },
      apply: async (sql, eventId) => {
        const bounds = await resolveSectionPositionTx(sql, params.folderId, params);
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

  async createItem(params: FolderActorParams & {
    folderId: string;
    sectionId: string;
    title: string;
    howTo?: string;
    itemId?: string;
    assignee?: ChecklistAssigneeInput | null;
    afterItemId?: string | null;
    beforeItemId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ChecklistMutationResult> {
    const itemId = params.itemId ?? randomUUID();
    return await this.core.mutate({
      folderId: params.folderId,
      targetKind: "item",
      targetId: itemId,
      operationType: "create_checklist_item",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      payload: {
        section_id: params.sectionId,
        title: params.title,
        how_to: params.howTo ?? "",
        assignee: params.assignee ?? null,
      },
      preflight: (sql) => this.repo.assertSectionBelongsToFolderTx(sql, params.sectionId, params.folderId),
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

  async patchItem(params: FolderActorParams & {
    folderId: string;
    itemId: string;
    expectedVersion: number;
    title?: string;
    howTo?: string;
    archived?: boolean;
    assignee?: ChecklistAssigneeInput | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ChecklistMutationResult> {
    const assigneeFields = Object.prototype.hasOwnProperty.call(params, "assignee")
      ? assigneeToFields(params.assignee)
      : {};
    assertFolderPatchHasFields("item", {
      title: params.title,
      howTo: params.howTo,
      archived: params.archived,
      ...assigneeFields,
    });
    return await this.core.mutate({
      folderId: params.folderId,
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
        await this.repo.assertItemBelongsToFolderTx(sql, params.itemId, params.folderId);
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

  async setItemAssignee(params: FolderActorParams & {
    folderId: string;
    itemId: string;
    expectedVersion: number;
    assignee?: ChecklistAssigneeInput | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ChecklistMutationResult> {
    return await this.core.mutate({
      folderId: params.folderId,
      targetKind: "item",
      targetId: params.itemId,
      operationType: "set_checklist_item_assignee",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: { assignee: params.assignee ?? null },
      preflight: async (sql) => {
        await this.repo.assertItemBelongsToFolderTx(sql, params.itemId, params.folderId);
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
    return await this.core.moveItem(params);
  }

  async setItemStatus(params: FolderActorParams & {
    itemId: string;
    expectedVersion: number;
    status: ChecklistItemStatus;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ChecklistMutationResult> {
    return await this.core.setItemStatus(params);
  }
}

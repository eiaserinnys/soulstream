import { randomUUID } from "node:crypto";

import { generateKeyBetween } from "@soulstream/fractional-position";

import type { TaskItemStatus, TaskSnapshot, TaskStatus } from "../db/session_db_types.js";

import { assigneeToFields, type TaskAssigneeInput } from "./task_models.js";
import { TaskMutationCore } from "./task_mutation_core.js";
import { enrollTaskCreatorSession, type TaskCreatorBoardItemMoverPort, type TaskCreatorEnrollmentLoggerPort } from "./task_creator_enrollment.js";
import { itemPatchOperationType, taskPatchOperationType, sectionPatchOperationType } from "./task_operation_types.js";
import { resolveItemPositionTx, resolveSectionPositionTx } from "./task_position_queries.js";
import type { TaskRepository } from "./task_repository.js";
import {
  removeTaskBoardItemIfUnlinked,
  resolveTaskIdempotent,
  type TaskBoardYjsPort,
  updateTaskBoardItemTitle,
  upsertTaskBoardItem,
} from "./task_board_items.js";
import { mutateTaskCreation } from "./task_creation_mutation.js";
import type {
  TaskActorParams,
  TaskBroadcasterPort,
  TaskDbPort,
  TaskHandoffNotifierPort,
  TaskMutationResult,
} from "./task_service_models.js";

export type {
  TaskActorParams,
  TaskBroadcasterPort,
  TaskDbPort,
  TaskMutationResult,
} from "./task_service_models.js";

export class TaskService {
  private readonly repo: TaskRepository;
  private readonly core: TaskMutationCore;

  constructor(
    private readonly db: TaskDbPort,
    private readonly broadcaster: TaskBroadcasterPort | undefined,
    private readonly boardYjsService: TaskBoardYjsPort,
    handoffNotifier?: TaskHandoffNotifierPort,
    private readonly creatorBoardItemMover?: TaskCreatorBoardItemMoverPort,
    private readonly logger?: TaskCreatorEnrollmentLoggerPort,
  ) {
    this.repo = db.tasks();
    this.core = new TaskMutationCore(db, this.repo, broadcaster, handoffNotifier);
  }

  async getTask(taskId: string): Promise<TaskSnapshot | null> {
    return await this.repo.getSnapshot(taskId);
  }

  async listTasks(params: {
    folderId: string;
    includeArchived?: boolean;
    limit?: number;
  }) {
    return await this.repo.listTasks(params);
  }

  async listMyTurnItems(params: { userId?: string | null; limit?: number } = {}) {
    return await this.repo.listMyTurnItems(params);
  }

  async listOperations(taskId: string, limit?: number) {
    return await this.repo.listOperations(taskId, limit);
  }

  async createTask(params: Omit<TaskActorParams, "actorSessionId"> & {
    actorSessionId: string | null;
    taskId?: string;
    folderId: string;
    title: string;
    x?: number;
    y?: number;
    idempotencyKey?: string | null;
    enrollCreator?: boolean;
  }): Promise<TaskMutationResult> {
    const taskId = params.taskId ?? randomUUID();
    const boardItemId = `task:${taskId}`;
    const x = params.x ?? 0;
    const y = params.y ?? 0;
    const idempotent = await resolveTaskIdempotent(this.repo, params.idempotencyKey);
    if (idempotent) return idempotent;
    await upsertTaskBoardItem(this.boardYjsService, {
      folderId: params.folderId,
      boardItemId,
      taskId,
      title: params.title,
      x,
      y,
    });
    let result: TaskMutationResult;
    try {
      result = await mutateTaskCreation(this.core, this.repo, {
        ...params,
        taskId,
        boardItemId,
        x,
        y,
      });
    } catch (err) {
      await removeTaskBoardItemIfUnlinked(this.repo, this.boardYjsService, {
        folderId: params.folderId,
        boardItemId,
        taskId,
      }).catch(() => undefined);
      throw err;
    }
    const creatorEnrolled = params.enrollCreator === false || params.actorSessionId === null
      ? false
      : (await enrollTaskCreatorSession({
          mover: this.creatorBoardItemMover, logger: this.logger,
          actorSessionId: params.actorSessionId, taskId,
        })) ?? false;
    if (!creatorEnrolled) await this.broadcastCatalog();
    return result;
  }

  async patchTask(params: TaskActorParams & {
    taskId: string;
    expectedVersion: number;
    title?: string;
    archived?: boolean;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    const result = await this.core.mutate({
      taskId: params.taskId,
      targetKind: "task",
      targetId: params.taskId,
      operationType: taskPatchOperationType(params.archived),
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: { title: params.title, archived: params.archived },
      preflight: (sql) =>
        this.repo.assertTaskVersionTx(sql, params.taskId, params.expectedVersion),
      apply: async (sql) => {
        await this.repo.patchTaskTx(
          sql,
          params.taskId,
          { title: params.title, archived: params.archived },
          params.expectedVersion,
        );
      },
    });
    if (params.title !== undefined) {
      await updateTaskBoardItemTitle(
        this.repo,
        this.boardYjsService,
        params.taskId,
        params.title,
      );
    }
    if (params.title !== undefined || params.archived !== undefined) {
      await this.broadcastCatalog();
    }
    return result;
  }

  async setTaskStatus(params: TaskActorParams & {
    taskId: string;
    expectedVersion: number;
    status: TaskStatus;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    return await this.core.setTaskStatus(params);
  }

  private async broadcastCatalog(): Promise<void> {
    if (!this.broadcaster?.emitCatalogUpdated) return;
    await this.broadcaster.emitCatalogUpdated(await this.db.getCatalog());
  }

  async createSection(params: TaskActorParams & {
    taskId: string;
    title: string;
    sectionId?: string;
    assignee?: TaskAssigneeInput | null;
    afterSectionId?: string | null;
    beforeSectionId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    const sectionId = params.sectionId ?? randomUUID();
    return await this.core.mutate({
      taskId: params.taskId,
      targetKind: "section",
      targetId: sectionId,
      operationType: "create_task_section",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      payload: {
        title: params.title,
        after_section_id: params.afterSectionId ?? null,
        before_section_id: params.beforeSectionId ?? null,
        assignee: params.assignee ?? null,
      },
      apply: async (sql, eventId) => {
        const bounds = await resolveSectionPositionTx(sql, params.taskId, params);
        await this.repo.createSectionTx(sql, {
          id: sectionId,
          taskId: params.taskId,
          title: params.title,
          positionKey: generateKeyBetween(bounds.lower, bounds.upper),
          assignee: assigneeToFields(params.assignee),
          actorSessionId: params.actorSessionId,
          eventId,
        });
      },
    });
  }

  async patchSection(params: TaskActorParams & {
    taskId: string;
    sectionId: string;
    expectedVersion: number;
    title?: string;
    archived?: boolean;
    assignee?: TaskAssigneeInput | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    const assigneeFields =
      Object.prototype.hasOwnProperty.call(params, "assignee")
        ? assigneeToFields(params.assignee)
        : {};
    return await this.core.mutate({
      taskId: params.taskId,
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
        await this.repo.assertSectionBelongsToTaskTx(sql, params.sectionId, params.taskId);
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

  async setSectionAssignee(params: TaskActorParams & {
    taskId: string;
    sectionId: string;
    expectedVersion: number;
    assignee?: TaskAssigneeInput | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    return await this.core.mutate({
      taskId: params.taskId,
      targetKind: "section",
      targetId: params.sectionId,
      operationType: "set_task_section_assignee",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: { assignee: params.assignee ?? null },
      preflight: async (sql) => {
        await this.repo.assertSectionBelongsToTaskTx(sql, params.sectionId, params.taskId);
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

  async moveSection(params: TaskActorParams & {
    taskId: string;
    sectionId: string;
    expectedVersion: number;
    afterSectionId?: string | null;
    beforeSectionId?: string | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    return await this.core.mutate({
      taskId: params.taskId,
      targetKind: "section",
      targetId: params.sectionId,
      operationType: "move_task_section",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: {
        after_section_id: params.afterSectionId ?? null,
        before_section_id: params.beforeSectionId ?? null,
      },
      preflight: async (sql) => {
        await this.repo.assertSectionBelongsToTaskTx(sql, params.sectionId, params.taskId);
        await this.repo.assertSectionVersionTx(sql, params.sectionId, params.expectedVersion);
      },
      apply: async (sql, eventId) => {
        const bounds = await resolveSectionPositionTx(sql, params.taskId, params);
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

  async createItem(params: TaskActorParams & {
    taskId: string;
    sectionId: string;
    title: string;
    howTo?: string;
    itemId?: string;
    assignee?: TaskAssigneeInput | null;
    afterItemId?: string | null;
    beforeItemId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    const itemId = params.itemId ?? randomUUID();
    return await this.core.mutate({
      taskId: params.taskId,
      targetKind: "item",
      targetId: itemId,
      operationType: "create_task_item",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      payload: {
        section_id: params.sectionId,
        title: params.title,
        how_to: params.howTo ?? "",
        assignee: params.assignee ?? null,
      },
      preflight: (sql) =>
        this.repo.assertSectionBelongsToTaskTx(sql, params.sectionId, params.taskId),
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

  async patchItem(params: TaskActorParams & {
    taskId: string;
    itemId: string;
    expectedVersion: number;
    title?: string;
    howTo?: string;
    archived?: boolean;
    assignee?: TaskAssigneeInput | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    const assigneeFields =
      Object.prototype.hasOwnProperty.call(params, "assignee")
        ? assigneeToFields(params.assignee)
        : {};
    return await this.core.mutate({
      taskId: params.taskId,
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
        await this.repo.assertItemBelongsToTaskTx(sql, params.itemId, params.taskId);
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

  async setItemAssignee(params: TaskActorParams & {
    taskId: string;
    itemId: string;
    expectedVersion: number;
    assignee?: TaskAssigneeInput | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    return await this.core.mutate({
      taskId: params.taskId,
      targetKind: "item",
      targetId: params.itemId,
      operationType: "set_task_item_assignee",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: { assignee: params.assignee ?? null },
      preflight: async (sql) => {
        await this.repo.assertItemBelongsToTaskTx(sql, params.itemId, params.taskId);
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

  async moveItem(params: TaskActorParams & {
    taskId: string;
    itemId: string;
    expectedVersion: number;
    sectionId?: string | null;
    afterItemId?: string | null;
    beforeItemId?: string | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    return await this.core.moveItem(params);
  }

  async setItemStatus(params: TaskActorParams & {
    itemId: string;
    expectedVersion: number;
    status: TaskItemStatus;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    return await this.core.setItemStatus(params);
  }
}

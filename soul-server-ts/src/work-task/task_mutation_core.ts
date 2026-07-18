import { randomUUID } from "node:crypto";

import { generateKeyBetween } from "@soulstream/fractional-position";

import type { RepositorySql } from "../db/repositories/repository_helpers.js";
import type {
  TaskItemStatus,
  TaskOperationRow,
  TaskOperationActorKind,
  TaskOperationTargetKind,
  TaskSnapshot,
  TaskStatus,
} from "../db/session_db_types.js";

import { TaskVersionConflict } from "./task_models.js";
import { resolveItemPositionTx } from "./task_position_queries.js";
import type { TaskRepository } from "./task_repository.js";
import type {
  TaskActorParams,
  TaskBroadcasterPort,
  TaskDbPort,
  TaskHandoffNotifierPort,
  TaskMutationResult,
} from "./task_service_models.js";

export interface TaskMutateParams {
  taskId: string;
  targetKind: TaskOperationTargetKind;
  targetId: string;
  operationType: string;
  actor: TaskActorParams;
  payload: Record<string, unknown>;
  preflight?: (sql: RepositorySql) => Promise<void>;
  apply: (sql: RepositorySql, eventId: number) => Promise<void>;
  reason?: string | null;
  idempotencyKey?: string | null;
}

export interface SessionlessTaskMutateParams {
  taskId: string;
  targetKind: TaskOperationTargetKind;
  targetId: string;
  operationType: string;
  actor: {
    actorKind: Extract<TaskOperationActorKind, "user" | "system">;
    actorSessionId: null;
    actorUserId?: string | null;
  };
  payload: Record<string, unknown>;
  apply: (sql: RepositorySql) => Promise<void>;
  reason?: string | null;
  idempotencyKey?: string | null;
}

type TaskEventParams = Omit<TaskMutateParams, "preflight" | "apply"> & {
  operationId: string;
};

export class TaskMutationCore {
  constructor(
    private readonly db: TaskDbPort,
    private readonly repo: TaskRepository,
    private readonly broadcaster?: TaskBroadcasterPort,
    private readonly handoffNotifier?: TaskHandoffNotifierPort,
  ) {}

  async mutate(params: TaskMutateParams): Promise<TaskMutationResult> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey);
    if (idempotent) return idempotent;

    let operation!: TaskOperationRow;
    let eventId = 0;
    await this.repo.transaction(async (sql) => {
      await params.preflight?.(sql);
      const opId = randomUUID();
      eventId = await this.appendTaskEvent(sql, { ...params, operationId: opId });
      await params.apply(sql, eventId);
      operation = await this.repo.appendOperationTx(sql, {
        id: opId,
        taskId: params.taskId,
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
      snapshot: await this.requireSnapshot(params.taskId),
      operation,
      eventId,
    };
    await this.broadcastMutation(params.actor.actorSessionId, result);
    return result;
  }

  async mutateWithoutSession(
    params: SessionlessTaskMutateParams,
  ): Promise<TaskMutationResult> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey);
    if (idempotent) return idempotent;

    let operation!: TaskOperationRow;
    await this.repo.transaction(async (sql) => {
      const operationId = randomUUID();
      await params.apply(sql);
      operation = await this.repo.appendOperationTx(sql, {
        id: operationId,
        taskId: params.taskId,
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
      snapshot: await this.requireSnapshot(params.taskId),
      operation,
      eventId: 0,
    };
  }

  async setItemStatus(params: TaskActorParams & {
    itemId: string;
    expectedVersion: number;
    status: TaskItemStatus;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey);
    if (idempotent) return idempotent;

    let taskId = "";
    let operation!: TaskOperationRow;
    let eventId = 0;
    let shouldNotifyHandoff = false;
    await this.repo.transaction(async (sql) => {
      taskId = await this.repo.getTaskIdForItemTx(sql, params.itemId);
      const item = await this.repo.getItemForUpdateTx(sql, params.itemId);
      const actualVersion = Number(item.version);
      if (actualVersion !== params.expectedVersion) {
        throw new TaskVersionConflict(
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
      eventId = await this.appendTaskEvent(sql, {
        operationId: opId,
        taskId,
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
        taskId,
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
      snapshot: await this.requireSnapshot(taskId),
      operation,
      eventId,
    };
    await this.broadcastMutation(params.actorSessionId, result);
    if (shouldNotifyHandoff) {
      this.notifyHumanHandoff(result);
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
    const idempotent = await this.resolveIdempotent(params.idempotencyKey);
    if (idempotent) return idempotent;

    let operation!: TaskOperationRow;
    let eventId = 0;
    await this.repo.transaction(async (sql) => {
      const task = await this.repo.getTaskForUpdateTx(sql, params.taskId);
      const actualVersion = Number(task.version);
      if (actualVersion !== params.expectedVersion) {
        throw new TaskVersionConflict(
          "task",
          params.taskId,
          params.expectedVersion,
          actualVersion,
        );
      }
      const opId = randomUUID();
      eventId = await this.appendTaskEvent(sql, {
        operationId: opId,
        taskId: params.taskId,
        operationType: "set_task_status",
        targetKind: "task",
        targetId: params.taskId,
        actor: params,
        payload: { status: params.status },
        reason: params.reason,
        idempotencyKey: params.idempotencyKey,
      });
      await this.repo.setTaskStatusTx(sql, {
        taskId: params.taskId,
        status: params.status,
        expectedVersion: params.expectedVersion,
        actorKind: params.actorKind ?? "agent",
        actorSessionId: params.actorSessionId,
        actorUserId: params.actorUserId ?? null,
        eventId,
      });
      operation = await this.repo.appendOperationTx(sql, {
        id: opId,
        taskId: params.taskId,
        targetKind: "task",
        targetId: params.taskId,
        operationType: "set_task_status",
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
      snapshot: await this.requireSnapshot(params.taskId),
      operation,
      eventId,
    };
    await this.broadcastMutation(params.actorSessionId, result);
    return result;
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
    let targetSectionId = params.sectionId ?? "";
    return await this.mutate({
      taskId: params.taskId,
      targetKind: "item",
      targetId: params.itemId,
      operationType: "move_task_item",
      actor: params,
      idempotencyKey: params.idempotencyKey,
      reason: params.reason,
      payload: {
        section_id: params.sectionId ?? null,
        after_item_id: params.afterItemId ?? null,
        before_item_id: params.beforeItemId ?? null,
      },
      preflight: async (sql) => {
        await this.repo.assertItemBelongsToTaskTx(sql, params.itemId, params.taskId);
        const item = await this.repo.getItemForUpdateTx(sql, params.itemId);
        const actualVersion = Number(item.version);
        if (actualVersion !== params.expectedVersion) {
          throw new TaskVersionConflict(
            "item",
            params.itemId,
            params.expectedVersion,
            actualVersion,
          );
        }
        targetSectionId = params.sectionId ?? item.section_id;
        await this.repo.assertSectionBelongsToTaskTx(sql, targetSectionId, params.taskId);
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
  ): Promise<TaskMutationResult | null> {
    if (!idempotencyKey) return null;
    const operation = await this.repo.getOperationByIdempotencyKey(idempotencyKey);
    if (!operation?.task_id) return null;
    return {
      snapshot: await this.requireSnapshot(operation.task_id),
      operation,
      eventId: operation.actor_event_id ?? 0,
      idempotent: true,
    };
  }

  private async appendTaskEvent(
    sql: RepositorySql,
    params: TaskEventParams,
  ): Promise<number> {
    return await this.db.appendEventTx(sql, {
      sessionId: params.actor.actorSessionId,
      eventType: "task_operation",
      payload: JSON.stringify({
        operation_id: params.operationId,
        operation_type: params.operationType,
        task_id: params.taskId,
        target_kind: params.targetKind,
        target_id: params.targetId,
        payload: params.payload,
        reason: params.reason ?? null,
      }),
      searchableText: `task operation ${params.operationType}`,
      createdAt: new Date(),
      dedupeKey: params.idempotencyKey ?? null,
    });
  }

  private async requireSnapshot(taskId: string): Promise<TaskSnapshot> {
    const snapshot = await this.repo.getSnapshot(taskId);
    if (!snapshot) throw new Error(`task not found: ${taskId}`);
    return snapshot;
  }

  private async broadcastMutation(
    actorSessionId: string,
    result: TaskMutationResult,
  ): Promise<void> {
    if (result.idempotent || !this.broadcaster) return;
    await this.broadcaster.emitTaskUpdated(
      actorSessionId,
      result.snapshot.task.id,
      result.snapshot.task.board_item_id,
    );
  }

  private notifyHumanHandoff(result: TaskMutationResult): void {
    if (!this.handoffNotifier) return;
    const item = result.snapshot.items.find(
      (candidate) => candidate.id === result.operation.target_id,
    );
    if (!item || !isTerminalHandoffStatus(item.status)) return;
    try {
      this.handoffNotifier.notifyHumanHandoff({
        taskId: result.snapshot.task.id,
        taskTitle: result.snapshot.task.title,
        boardItemId: result.snapshot.task.board_item_id,
        itemId: item.id,
        itemTitle: item.title,
        status: item.status,
        operationId: result.operation.id,
        eventId: result.eventId,
      });
    } catch {
      // The concrete notifier owns logging. A handoff wake must never fail the mutation.
    }
  }

}

function isTerminalHandoffStatus(
  status: TaskItemStatus,
): status is Extract<TaskItemStatus, "completed" | "cancelled"> {
  return status === "completed" || status === "cancelled";
}

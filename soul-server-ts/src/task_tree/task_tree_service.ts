import { randomUUID } from "node:crypto";

import { buildCallerInfoFromCallerSession } from "../caller_info.js";
import type { McpRuntime } from "../mcp/runtime.js";
import { resolveDelegatedFolderId } from "../session_folder_fallback.js";

import type {
  TaskItemRow,
  TaskOperationRow,
  TaskTreeStatus,
  VerificationOwner,
} from "./task_tree_repository.js";

export interface TaskMutationResult {
  task: TaskItemRow | null;
  operation: TaskOperationRow;
  event_id: number;
  idempotent?: boolean;
}

export class TaskTreeService {
  private readonly repo;

  constructor(private readonly runtime: McpRuntime) {
    this.repo = runtime.db.taskTree();
  }

  async createTaskItem(params: {
    sessionId: string;
    title: string;
    description?: string;
    acceptanceCriteria?: string;
    verificationOwner?: VerificationOwner;
    parentTaskId?: string | null;
    status?: TaskTreeStatus;
    setActive?: boolean;
    idempotencyKey?: string | null;
    linkedSessionId?: string | null;
    linkedNodeId?: string | null;
    navigationSessionId?: string | null;
    navigationNodeId?: string | null;
    navigationEventId?: number | null;
  }): Promise<TaskMutationResult> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey);
    if (idempotent) return idempotent;

    if (params.setActive) {
      await this.repo.clearActiveTaskForSession(params.sessionId);
    }
    const positionKey = await this.repo.nextPositionKey(params.parentTaskId ?? null);
    const linkedNodeId = params.linkedNodeId ?? (params.linkedSessionId ? this.runtime.nodeId : null);
    const navigationSessionId =
      params.navigationSessionId ?? params.linkedSessionId ?? params.sessionId;
    const navigationNodeId =
      params.navigationNodeId ??
      (navigationSessionId === params.linkedSessionId ? linkedNodeId : this.runtime.nodeId);
    let task = await this.repo.createTaskItem({
      id: randomUUID(),
      parentId: params.parentTaskId ?? null,
      positionKey,
      title: params.title,
      description: params.description,
      acceptanceCriteria: params.acceptanceCriteria,
      verificationOwner: params.verificationOwner,
      status: params.status ?? "open",
      linkedSessionId: params.linkedSessionId ?? null,
      linkedNodeId,
      activeForSessionId: params.setActive ? params.sessionId : null,
      createdFromSessionId: params.sessionId,
      navigationSessionId,
      navigationNodeId,
      navigationEventId: params.navigationEventId ?? null,
    });
    const recorded = await this.recordOperation({
      task,
      operationType: "create_task_item",
      actorSessionId: params.sessionId,
      idempotencyKey: params.idempotencyKey,
      payload: {
        parent_task_id: params.parentTaskId ?? null,
        title: params.title,
        status: task.status,
        linked_session_id: params.linkedSessionId ?? null,
        linked_node_id: linkedNodeId,
        navigation_session_id: navigationSessionId,
        navigation_node_id: navigationNodeId,
        navigation_event_id: params.navigationEventId ?? null,
      },
    });
    const shouldUseCreateOperationAnchor =
      !params.linkedSessionId &&
      params.navigationSessionId === undefined &&
      params.navigationEventId === undefined;
    task = await this.repo.patchTaskItem(task.id, {
      created_from_event_id: recorded.event_id,
      navigation_event_id: shouldUseCreateOperationAnchor
        ? recorded.event_id
        : params.navigationEventId ?? null,
    });
    return { ...recorded, task };
  }

  async delegateTaskItem(params: {
    sessionId: string;
    parentTaskId: string;
    title: string;
    prompt: string;
    agentId?: string;
    description?: string;
    acceptanceCriteria?: string;
    verificationOwner?: VerificationOwner;
    idempotencyKey?: string | null;
    folderId?: string | null;
  }): Promise<TaskMutationResult & { delegated_session_id?: string }> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey);
    if (idempotent) {
      return { ...idempotent, delegated_session_id: idempotent.task?.linked_session_id ?? undefined };
    }

    const positionKey = await this.repo.nextPositionKey(params.parentTaskId);
    let task = await this.repo.createTaskItem({
      id: randomUUID(),
      parentId: params.parentTaskId,
      positionKey,
      title: params.title,
      description: params.description,
      acceptanceCriteria: params.acceptanceCriteria,
      verificationOwner: params.verificationOwner,
      status: "in_progress",
      createdFromSessionId: params.sessionId,
      navigationSessionId: params.sessionId,
      navigationNodeId: this.runtime.nodeId,
    });

    const agents = this.runtime.agentRegistry.list();
    const defaultAgent = agents[0];
    const resolvedAgentId = params.agentId ?? defaultAgent?.id;
    const agent = resolvedAgentId
      ? this.runtime.agentRegistry.get(resolvedAgentId)
      : undefined;

    if (!agent || !resolvedAgentId) {
      task = await this.repo.patchTaskItem(task.id, { status: "blocked" });
      const failure = await this.recordOperation({
        task,
        operationType: "delegate_task_failed",
        actorSessionId: params.sessionId,
        idempotencyKey: params.idempotencyKey,
        payload: {
          parent_task_id: params.parentTaskId,
          title: params.title,
          error: `agent_id를 찾을 수 없습니다: ${params.agentId ?? "(default)"}`,
        },
      });
      return { ...failure, task };
    }

    const delegatedSessionId = randomUUID();
    try {
      const callerInfo = buildCallerInfoFromCallerSession(
        this.runtime,
        params.sessionId,
      );
      const childSession = await this.runtime.taskManager.createTask({
        agentSessionId: delegatedSessionId,
        prompt: params.prompt,
        profileId: resolvedAgentId,
        callerSessionId: params.sessionId,
        callerInfo,
        folderId: await resolveDelegatedFolderId(this.runtime, {
          callerSessionId: params.sessionId,
          ...(Object.prototype.hasOwnProperty.call(params, "folderId")
            ? { folderId: params.folderId }
            : {}),
        }),
      });
      this.runtime.taskExecutor.startExecution(childSession, agent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      task = await this.repo.patchTaskItem(task.id, { status: "blocked" });
      const failure = await this.recordOperation({
        task,
        operationType: "delegate_task_failed",
        actorSessionId: params.sessionId,
        idempotencyKey: params.idempotencyKey,
        payload: {
          parent_task_id: params.parentTaskId,
          title: params.title,
          delegated_session_id: delegatedSessionId,
          error: message,
        },
      });
      return { ...failure, task, delegated_session_id: delegatedSessionId };
    }

    const linkedEventId = await this.appendLinkedSessionEvent({
      linkedSessionId: delegatedSessionId,
      task,
      operationType: "delegate_task",
      actorSessionId: params.sessionId,
      payload: {
        parent_task_id: params.parentTaskId,
        title: params.title,
        delegated_session_id: delegatedSessionId,
      },
    });
    task = await this.repo.patchTaskItem(task.id, {
      linked_session_id: delegatedSessionId,
      linked_node_id: this.runtime.nodeId,
      active_for_session_id: delegatedSessionId,
      navigation_session_id: delegatedSessionId,
      navigation_node_id: this.runtime.nodeId,
      navigation_event_id: linkedEventId,
    });
    const recorded = await this.recordOperation({
      task,
      operationType: "delegate_task",
      actorSessionId: params.sessionId,
      idempotencyKey: params.idempotencyKey,
      payload: {
        parent_task_id: params.parentTaskId,
        title: params.title,
        delegated_session_id: delegatedSessionId,
      },
    });
    return { ...recorded, task, delegated_session_id: delegatedSessionId };
  }

  async updateTaskItem(params: {
    sessionId: string;
    taskId: string;
    title?: string;
    description?: string;
    acceptanceCriteria?: string;
    verificationOwner?: VerificationOwner;
    reason?: string | null;
    expectedVersion?: number | null;
  }): Promise<TaskMutationResult> {
    let task = await this.repo.patchTaskItem(
      params.taskId,
      {
        title: params.title,
        description: params.description,
        acceptance_criteria: params.acceptanceCriteria,
        verification_owner: params.verificationOwner,
      },
      params.expectedVersion,
    );
    const recorded = await this.recordOperation({
      task,
      operationType: "update_task_item",
      actorSessionId: params.sessionId,
      reason: params.reason,
      payload: {
        title: params.title,
        description: params.description,
        acceptance_criteria: params.acceptanceCriteria,
        verification_owner: params.verificationOwner,
      },
    });
    return { ...recorded, task };
  }

  async setStatus(params: {
    sessionId: string;
    taskId: string;
    status: TaskTreeStatus;
    reason?: string | null;
    expectedVersion?: number | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey);
    if (idempotent) return idempotent;

    let task = await this.repo.patchTaskItem(
      params.taskId,
      { status: params.status },
      params.expectedVersion,
    );
    const recorded = await this.recordOperation({
      task,
      operationType: "set_task_status",
      actorSessionId: params.sessionId,
      reason: params.reason,
      idempotencyKey: params.idempotencyKey,
      payload: { status: params.status },
    });
    return { ...recorded, task };
  }

  async moveTaskItem(params: {
    sessionId: string;
    taskId: string;
    newParentTaskId?: string | null;
    positionKey?: number;
    reason?: string | null;
    expectedVersion?: number | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey);
    if (idempotent) return idempotent;

    if (await this.repo.wouldCreateCycle(params.taskId, params.newParentTaskId ?? null)) {
      throw new Error("task tree cycle is not allowed");
    }
    const positionKey =
      params.positionKey ??
      (await this.repo.nextPositionKey(params.newParentTaskId ?? null));
    let task = await this.repo.patchTaskItem(
      params.taskId,
      {
        parent_id: params.newParentTaskId ?? null,
        position_key: positionKey,
      },
      params.expectedVersion,
    );
    const recorded = await this.recordOperation({
      task,
      operationType: "move_task_item",
      actorSessionId: params.sessionId,
      reason: params.reason,
      idempotencyKey: params.idempotencyKey,
      payload: {
        new_parent_task_id: params.newParentTaskId ?? null,
        position_key: positionKey,
      },
    });
    return { ...recorded, task };
  }

  async linkSession(params: {
    sessionId: string;
    taskId: string;
    linkedSessionId: string;
    linkedNodeId?: string | null;
    navigationEventId?: number | null;
    useOperationAnchor?: boolean;
    reason?: string | null;
    expectedVersion?: number | null;
  }): Promise<TaskMutationResult> {
    let task = await this.repo.patchTaskItem(
      params.taskId,
      {
        linked_session_id: params.linkedSessionId,
        linked_node_id: params.linkedNodeId ?? this.runtime.nodeId,
        navigation_session_id: params.linkedSessionId,
        navigation_node_id: params.linkedNodeId ?? this.runtime.nodeId,
        navigation_event_id: params.useOperationAnchor
          ? null
          : params.navigationEventId ?? null,
      },
      params.expectedVersion,
    );
    const recorded = await this.recordOperation({
      task,
      operationType: "link_task_session",
      actorSessionId: params.sessionId,
      reason: params.reason,
      payload: {
        linked_session_id: params.linkedSessionId,
        linked_node_id: params.linkedNodeId ?? this.runtime.nodeId,
        navigation_event_id: params.navigationEventId ?? null,
        use_operation_anchor: params.useOperationAnchor ?? false,
      },
    });
    if (params.useOperationAnchor) {
      task = await this.updateNavigationToOperation(
        task,
        recorded.event_id,
        params.sessionId,
      );
    }
    return { ...recorded, task };
  }

  async setActiveTask(params: {
    sessionId: string;
    taskId?: string | null;
    reason?: string | null;
  }): Promise<TaskMutationResult> {
    const existing = params.taskId
      ? await this.repo.getTaskItem(params.taskId)
      : null;
    if (params.taskId && !existing) {
      throw new Error(`task item not found: ${params.taskId}`);
    }
    await this.repo.clearActiveTaskForSession(params.sessionId);
    const task = existing
      ? await this.repo.patchTaskItem(existing.id, {
          active_for_session_id: params.sessionId,
        })
      : null;
    const recorded = await this.recordOperation({
      task,
      operationType: "set_active_task",
      actorSessionId: params.sessionId,
      reason: params.reason,
      payload: { active_task_id: params.taskId ?? null },
    });
    if (!task) return recorded;
    return { ...recorded, task };
  }

  async archiveTaskItem(params: {
    sessionId: string;
    taskId: string;
    reason?: string | null;
    expectedVersion?: number | null;
  }): Promise<TaskMutationResult> {
    let task = await this.repo.patchTaskItem(
      params.taskId,
      {
        archived: true,
        active_for_session_id: null,
      },
      params.expectedVersion,
    );
    const recorded = await this.recordOperation({
      task,
      operationType: "archive_task_item",
      actorSessionId: params.sessionId,
      reason: params.reason,
      payload: { archived: true },
    });
    return { ...recorded, task };
  }

  async setPinned(params: {
    sessionId: string;
    taskId: string;
    pinned: boolean;
    reason?: string | null;
    expectedVersion?: number | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey);
    if (idempotent) return idempotent;

    const task = await this.repo.patchTaskItem(
      params.taskId,
      { pinned: params.pinned },
      params.expectedVersion,
    );
    const recorded = await this.recordOperation({
      task,
      operationType: "set_task_pinned",
      actorSessionId: params.sessionId,
      reason: params.reason,
      idempotencyKey: params.idempotencyKey,
      payload: { pinned: params.pinned },
    });
    return { ...recorded, task };
  }

  async holdTaskItem(params: {
    sessionId: string;
    taskId: string;
    reason?: string | null;
    expectedVersion?: number | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    const idempotent = await this.resolveIdempotent(params.idempotencyKey);
    if (idempotent) return idempotent;

    const task = await this.repo.patchTaskItem(
      params.taskId,
      { status: "blocked" },
      params.expectedVersion,
    );
    const recorded = await this.recordOperation({
      task,
      operationType: "hold_task_item",
      actorSessionId: params.sessionId,
      reason: params.reason,
      idempotencyKey: params.idempotencyKey,
      payload: { status: "blocked" },
    });
    return { ...recorded, task };
  }

  async getTaskContext(sessionId: string): Promise<{
    active_task: TaskItemRow | null;
    active_task_path: TaskItemRow[];
    linked_tasks: TaskItemRow[];
  }> {
    const active = await this.repo.getActiveTaskForSession(sessionId);
    const path = active ? await this.repo.getTaskPath(active.id) : [];
    const linked = await this.repo.listTaskItems({
      linkedSessionId: sessionId,
      includeArchived: false,
      limit: 100,
    });
    return {
      active_task: active,
      active_task_path: path,
      linked_tasks: linked,
    };
  }

  async searchTaskItems(params: {
    query?: string;
    status?: TaskTreeStatus;
    rootTaskId?: string;
    linkedSessionId?: string;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<Array<{ task: TaskItemRow; path: TaskItemRow[] }>> {
    const tasks =
      params.rootTaskId || params.linkedSessionId || params.includeArchived
        ? await this.repo.listTaskItems({
            rootTaskId: params.rootTaskId,
            linkedSessionId: params.linkedSessionId,
            status: params.status,
            includeArchived: params.includeArchived,
            limit: params.limit,
          })
        : await this.repo.searchTaskItems(params);
    return await Promise.all(
      tasks.map(async (task) => ({
        task,
        path: await this.repo.getTaskPath(task.id),
      })),
    );
  }

  async listOperations(taskId: string, limit?: number): Promise<TaskOperationRow[]> {
    return await this.repo.listTaskOperations(taskId, limit);
  }

  private async resolveIdempotent(
    idempotencyKey?: string | null,
  ): Promise<TaskMutationResult | null> {
    if (!idempotencyKey) return null;
    const operation = await this.repo.getTaskOperationByIdempotencyKey(idempotencyKey);
    if (!operation) return null;
    const task = operation.task_id
      ? await this.repo.getTaskItem(operation.task_id)
      : null;
    return {
      task,
      operation,
      event_id: operation.actor_event_id ?? 0,
      idempotent: true,
    };
  }

  private async recordOperation(params: {
    task: TaskItemRow | null;
    operationType: string;
    actorSessionId: string;
    payload: Record<string, unknown>;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    let operation = await this.repo.appendTaskOperation({
      id: randomUUID(),
      taskId: params.task?.id ?? null,
      operationType: params.operationType,
      actorSessionId: params.actorSessionId,
      idempotencyKey: params.idempotencyKey,
      payload: params.payload,
      reason: params.reason,
    });
    const eventId = await this.runtime.db.appendEvent({
      sessionId: params.actorSessionId,
      eventType: "task_operation",
      payload: JSON.stringify({
        operation_id: operation.id,
        operation_type: params.operationType,
        task_id: params.task?.id ?? null,
        task: params.task,
        payload: params.payload,
        reason: params.reason ?? null,
      }),
      searchableText: this.operationSearchText(params.operationType, params.task),
      createdAt: new Date(),
    });
    operation = await this.repo.setTaskOperationEventId(operation.id, eventId);
    return {
      task: params.task,
      operation,
      event_id: eventId,
    };
  }

  private async appendLinkedSessionEvent(params: {
    linkedSessionId: string;
    task: TaskItemRow;
    operationType: string;
    actorSessionId: string;
    payload: Record<string, unknown>;
  }): Promise<number | null> {
    try {
      return await this.runtime.db.appendEvent({
        sessionId: params.linkedSessionId,
        eventType: "task_operation",
        payload: JSON.stringify({
          operation_type: params.operationType,
          task_id: params.task.id,
          task: params.task,
          payload: params.payload,
          source_session_id: params.actorSessionId,
        }),
        searchableText: this.operationSearchText(params.operationType, params.task),
        createdAt: new Date(),
      });
    } catch (err) {
      this.runtime.logger.warn(
        { err, linkedSessionId: params.linkedSessionId, taskId: params.task.id },
        "failed to append linked task_operation event",
      );
      return null;
    }
  }

  private async updateNavigationToOperation(
    task: TaskItemRow,
    eventId: number,
    sessionId: string,
  ): Promise<TaskItemRow> {
    return await this.repo.patchTaskItem(task.id, {
      navigation_session_id: sessionId,
      navigation_node_id: this.runtime.nodeId,
      navigation_event_id: eventId,
    });
  }

  private operationSearchText(
    operationType: string,
    task: TaskItemRow | null,
  ): string {
    if (!task) return `task operation ${operationType}`;
    return `task operation ${operationType} ${task.title} ${task.status}`;
  }
}

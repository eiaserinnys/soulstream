import type { Logger } from "pino";

import type {
  TaskItemStatus,
  TaskSnapshot,
  TaskStatus,
} from "../db/session_db_types.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";
import { TaskVersionConflict, type TaskAssigneeInput } from "./task_models.js";
import type {
  TaskActorParams,
  TaskHandoffNotifierPort,
  TaskMutationResult,
} from "./task_service_models.js";

export type { TaskActorParams, TaskMutationResult } from "./task_service_models.js";

/** Worker-side task facade. All persistence is owned by the orchestrator host. */
export class TaskService {
  private handoffNotifier?: TaskHandoffNotifierPort;

  constructor(private readonly config: { orch: OrchProxyConfig; logger: Logger }) {}

  setHandoffNotifier(notifier: TaskHandoffNotifierPort): void {
    this.handoffNotifier = notifier;
  }

  async getTask(taskId: string): Promise<TaskSnapshot | null> {
    return await this.request("get_task", { taskId });
  }

  async listTasks(params: { folderId: string; includeArchived?: boolean; limit?: number }) {
    return await this.request("list_tasks", params);
  }

  async listMyTurnItems(params: { userId?: string | null; limit?: number } = {}) {
    return await this.request("list_my_turn_items", params);
  }

  async listOperations(taskId: string, limit?: number) {
    return await this.request("list_operations", { taskId, limit });
  }

  async listAgentSubscriberSessionIds(taskId: string): Promise<string[]> {
    return await this.request("list_agent_subscribers", { taskId });
  }

  async setTaskStatus(params: TaskActorParams & {
    taskId: string;
    expectedVersion: number;
    status: TaskStatus;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    return await this.mutate("set_task_status", params);
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
    return await this.mutate("create_section", params);
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
    return await this.mutate("patch_section", params);
  }

  async setSectionAssignee(params: TaskActorParams & {
    taskId: string;
    sectionId: string;
    expectedVersion: number;
    assignee?: TaskAssigneeInput | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    return await this.mutate("set_section_assignee", params);
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
    return await this.mutate("move_section", params);
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
    return await this.mutate("create_item", params);
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
    return await this.mutate("patch_item", params);
  }

  async setItemAssignee(params: TaskActorParams & {
    taskId: string;
    itemId: string;
    expectedVersion: number;
    assignee?: TaskAssigneeInput | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    return await this.mutate("set_item_assignee", params);
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
    return await this.mutate("move_item", params);
  }

  async setItemStatus(params: TaskActorParams & {
    itemId: string;
    expectedVersion: number;
    status: TaskItemStatus;
    reason?: string | null;
    idempotencyKey?: string | null;
  }): Promise<TaskMutationResult> {
    return await this.mutate("set_item_status", params);
  }

  private async mutate(operation: string, input: object): Promise<TaskMutationResult> {
    const actor = input as { actorKind?: unknown };
    const result = await this.request<TaskMutationResult>(operation, {
      ...input,
      actorKind: actor.actorKind ?? "agent",
    });
    if (result.handoff) {
      try {
        this.handoffNotifier?.notifyHumanHandoff(result.handoff);
      } catch (error) {
        this.config.logger.warn({ err: error, operation }, "task handoff notifier failed");
      }
    }
    return result;
  }

  private async request<T = unknown>(operation: string, input: object): Promise<T> {
    const response = await fetch(
      `${this.config.orch.baseUrl}/api/tasks/host/${encodeURIComponent(operation)}`,
      {
        method: "POST",
        headers: { ...this.config.orch.headers, "content-type": "application/json" },
        body: JSON.stringify(snakeCase(input)),
      },
    );
    if (!response.ok) {
      const failure = await responseError(response);
      if (response.status === 409 && isVersionConflictDetails(failure.details)) {
        throw new TaskVersionConflict(
          failure.details.targetKind,
          failure.details.targetId,
          failure.details.expectedVersion,
          failure.details.actualVersion,
        );
      }
      const error = Object.assign(new Error(`task host ${operation} failed: ${failure.message}`), {
        statusCode: response.status,
      });
      this.config.logger.warn(
        { operation, status: response.status, message: failure.message },
        "task control-plane host request failed",
      );
      throw error;
    }
    return await response.json() as T;
  }
}

function snakeCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeCase);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [snakeKey(key), snakeCase(child)]),
  );
}

function snakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

async function responseError(
  response: Response,
): Promise<{ message: string; details?: Record<string, unknown> }> {
  const text = await response.text();
  if (!text) return { message: `${response.status} ${response.statusText}` };
  try {
    const detail = (JSON.parse(text) as {
      detail?: { error?: { message?: unknown; details?: unknown } };
    }).detail;
    if (typeof detail?.error?.message === "string") {
      const details = detail.error.details;
      return {
        message: detail.error.message,
        ...(details && typeof details === "object" && !Array.isArray(details)
          ? { details: details as Record<string, unknown> }
          : {}),
      };
    }
  } catch {
    return { message: text };
  }
  return { message: text };
}

function isVersionConflictDetails(value: Record<string, unknown> | undefined): value is {
  targetKind: "task" | "section" | "item";
  targetId: string;
  expectedVersion: number;
  actualVersion: number;
} {
  return value !== undefined
    && (value.targetKind === "task" || value.targetKind === "section" || value.targetKind === "item")
    && typeof value.targetId === "string"
    && typeof value.expectedVersion === "number"
    && typeof value.actualVersion === "number";
}

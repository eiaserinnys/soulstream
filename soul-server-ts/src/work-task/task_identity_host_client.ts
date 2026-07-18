import type { Logger } from "pino";
import {
  serializeInitialTaskContext,
  type InitialTaskContext,
} from "@soulstream/page-model";

import type { OrchProxyConfig } from "../mcp/runtime.js";

export interface TaskIdentityActor {
  actorKind: "agent" | "user" | "system";
  actorSessionId?: string | null;
  actorUserId?: string | null;
}

export interface TaskIdentityHostResult {
  id: string;
  pageId: string;
  taskId: string;
  snapshot: Record<string, unknown>;
  operation: Record<string, unknown>;
  pageOperation: Record<string, unknown>;
  idempotent?: boolean;
}

export class TaskIdentityHostClient {
  constructor(private readonly config: { orch: OrchProxyConfig; logger: Logger }) {}

  async create(input: TaskIdentityActor & {
    title: string;
    description?: string;
    folderId: string;
    taskId?: string;
    x?: number;
    y?: number;
    idempotencyKey: string;
    initialContext?: InitialTaskContext;
  }): Promise<TaskIdentityHostResult> {
    const initialContext = serializeInitialTaskContext(input.initialContext);
    return await this.request("create", {
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      folder_id: input.folderId,
      ...(input.taskId ? { task_id: input.taskId } : {}),
      ...(input.x !== undefined ? { x: input.x } : {}),
      ...(input.y !== undefined ? { y: input.y } : {}),
      ...(initialContext ? { initial_context: initialContext } : {}),
      ...actor(input),
      idempotency_key: input.idempotencyKey,
    });
  }

  async promoteExistingPage(input: TaskIdentityActor & {
    pageId: string;
    title: string;
    folderId: string;
    x?: number;
    y?: number;
    idempotencyKey: string;
  }): Promise<TaskIdentityHostResult> {
    return await this.request("promote-page", {
      page_id: input.pageId,
      title: input.title,
      folder_id: input.folderId,
      ...(input.x !== undefined ? { x: input.x } : {}),
      ...(input.y !== undefined ? { y: input.y } : {}),
      ...actor(input),
      idempotency_key: input.idempotencyKey,
    });
  }

  async update(input: TaskIdentityActor & {
    taskId: string;
    expectedVersion: number;
    title?: string;
    archived?: boolean;
    reason?: string | null;
    idempotencyKey: string;
  }): Promise<TaskIdentityHostResult> {
    const operation = input.title !== undefined
      ? "update"
      : input.archived === true ? "archive" : "unarchive";
    return await this.request(operation, {
      task_id: input.taskId,
      expected_version: input.expectedVersion,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...actor(input),
      idempotency_key: input.idempotencyKey,
    });
  }

  private async request(operation: string, body: unknown): Promise<TaskIdentityHostResult> {
    const response = await fetch(
      `${this.config.orch.baseUrl}/api/task-identities/host/${encodeURIComponent(operation)}`,
      {
        method: "POST",
        headers: { ...this.config.orch.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const message = await responseErrorMessage(response);
      this.config.logger.warn(
        { operation, status: response.status, message },
        "task identity host request failed",
      );
      throw new Error(`task identity host ${operation} failed: ${message}`);
    }
    return await response.json() as TaskIdentityHostResult;
  }
}

function actor(input: TaskIdentityActor) {
  return {
    actor_kind: input.actorKind,
    actor_session_id: input.actorSessionId ?? null,
    actor_user_id: input.actorUserId ?? null,
  };
}

async function responseErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `${response.status} ${response.statusText}`;
  try {
    const detail = (JSON.parse(text) as { detail?: { error?: { message?: unknown } } }).detail;
    if (typeof detail?.error?.message === "string") return detail.error.message;
  } catch {
    return text;
  }
  return text;
}

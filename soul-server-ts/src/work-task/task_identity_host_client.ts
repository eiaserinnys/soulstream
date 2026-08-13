import type { Logger } from "pino";
import {
  serializeInitialTaskContext,
  type InitialTaskContext,
} from "@soulstream/page-model";

import type { OrchProxyConfig } from "../mcp/runtime.js";

export interface TaskIdentityActor {
  actorKind: "agent" | "user" | "system" | "llm";
  actorSessionId?: string | null;
  actorUserId?: string | null;
}

export interface TaskIdentityPageResolution {
  id: string;
  pageId: string;
  taskId: string;
  adopted: boolean;
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

export class TaskIdentityHostClientError extends Error {
  constructor(
    readonly code: string | null,
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TaskIdentityHostClientError";
  }
}

export class TaskIdentityHostClient {
  constructor(private readonly config: { orch: OrchProxyConfig; logger: Logger }) {}

  async resolvePageIdentity(pageId: string): Promise<TaskIdentityPageResolution | null> {
    return await this.request<TaskIdentityPageResolution | null>("resolve-page", {
      page_id: pageId,
    });
  }

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
  }): Promise<TaskIdentityPageResolution> {
    return await this.request<TaskIdentityPageResolution>("promote-page", {
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

  private async request<T = TaskIdentityHostResult>(operation: string, body: unknown): Promise<T> {
    const response = await fetch(
      `${this.config.orch.baseUrl}/api/task-identities/host/${encodeURIComponent(operation)}`,
      {
        method: "POST",
        headers: { ...this.config.orch.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const detail = await responseErrorDetail(response);
      this.config.logger.warn(
        { operation, status: response.status, message: detail.message, code: detail.code },
        "task identity host request failed",
      );
      throw new TaskIdentityHostClientError(
        detail.code,
        response.status,
        `task identity host ${operation} failed: ${detail.message}`,
        detail.details,
      );
    }
    return await response.json() as T;
  }
}

function actor(input: TaskIdentityActor) {
  return {
    actor_kind: input.actorKind,
    actor_session_id: input.actorSessionId ?? null,
    actor_user_id: input.actorUserId ?? null,
  };
}

async function responseErrorDetail(response: Response): Promise<{
  message: string;
  code: string | null;
  details: Record<string, unknown>;
}> {
  const text = await response.text();
  if (!text) {
    return { message: `${response.status} ${response.statusText}`, code: null, details: {} };
  }
  try {
    const detail = (JSON.parse(text) as {
      detail?: { error?: { message?: unknown; code?: unknown; details?: unknown } };
    }).detail;
    if (typeof detail?.error?.message === "string") {
      const details = detail.error.details;
      return {
        message: detail.error.message,
        code: typeof detail.error.code === "string" ? detail.error.code : null,
        details: details !== null && typeof details === "object" && !Array.isArray(details)
          ? details as Record<string, unknown>
          : {},
      };
    }
  } catch {
    return { message: text, code: null, details: {} };
  }
  return { message: text, code: null, details: {} };
}

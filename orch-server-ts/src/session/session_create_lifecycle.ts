import type { FastifyRequest } from "fastify";

import type {
  BoardContainerTarget,
  BoardItemCatalogSnapshot,
  BoardItemRecord,
  BoardItemRouteProvider,
} from "../board/board_item_routes.js";
import type {
  TaskMutationResponse,
} from "../tasks/task_mutation_routes.js";
import type { SerializedTaskItem } from "../tasks/task_read_routes.js";
import {
  firstAllowedSessionFolderId,
  type SessionResourceAccessProvider,
} from "./session_resource_access.js";

type JsonObject = Record<string, unknown>;

export type SessionCallerInfoResolver = (
  request: FastifyRequest,
  bodyCallerInfo: JsonObject | null | undefined,
  systemNodeId: string,
) => Promise<JsonObject> | JsonObject;

export type TaskScopedSessionProvider = {
  readonly findTaskScopedSession: (
    idempotencyKey: string,
  ) => Promise<TaskMutationResponse | null> | TaskMutationResponse | null;
  readonly getTask: (
    taskId: string,
  ) => Promise<SerializedTaskItem | null> | SerializedTaskItem | null;
  readonly createTaskScopedChild: (
    input: CreateTaskScopedChildInput,
  ) => Promise<TaskMutationResponse> | TaskMutationResponse;
};

export type CreateTaskScopedChildInput = {
  readonly parentTask: SerializedTaskItem;
  readonly childSessionId: string;
  readonly childNodeId: string | null;
  readonly prompt: string;
  readonly idempotencyKey?: string;
};

export type SessionCreateResponse = {
  readonly agentSessionId: string;
  readonly nodeId?: string | null;
  readonly task?: SerializedTaskItem | null;
  readonly taskOperation?: TaskMutationResponse["operation"];
  readonly taskEventId?: number;
  readonly idempotent?: boolean;
};

type TaskScopeContext = {
  readonly parentTask: SerializedTaskItem;
  readonly idempotencyKey?: string;
};

export type PreparedSessionCreate = {
  readonly payload: JsonObject;
  readonly existingResponse?: SessionCreateResponse;
  readonly taskScope?: TaskScopeContext;
};

export type PrepareSessionCreateInput = {
  readonly request: FastifyRequest;
  readonly body: JsonObject;
};

export type CompleteSessionCreateInput = {
  readonly prepared: PreparedSessionCreate;
  readonly childSessionId: string;
  readonly childNodeId: string | null;
  readonly prompt: string;
};

export type SessionCreateLifecycle = {
  readonly prepare: (
    input: PrepareSessionCreateInput,
  ) => Promise<PreparedSessionCreate>;
  readonly complete: (
    input: CompleteSessionCreateInput,
  ) => Promise<Record<string, unknown>>;
};

export type CreateSessionCreateLifecycleOptions = {
  readonly resolveCallerInfo: SessionCallerInfoResolver;
  readonly boardItems: BoardItemRouteProvider;
  readonly access: SessionResourceAccessProvider;
  readonly tasks: TaskScopedSessionProvider;
};

export class SessionCreateLifecycleError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "SessionCreateLifecycleError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function createSessionCreateLifecycle(
  options: CreateSessionCreateLifecycleOptions,
): SessionCreateLifecycle {
  return {
    async prepare(input) {
      try {
        return await prepareSessionCreate(options, input);
      } catch (error) {
        throw normalizeLifecycleError(error);
      }
    },
    async complete(input) {
      const taskScope = input.prepared.taskScope;
      if (taskScope === undefined) return {};
      try {
        const result = await options.tasks.createTaskScopedChild({
          parentTask: taskScope.parentTask,
          childSessionId: input.childSessionId,
          childNodeId: input.childNodeId,
          prompt: input.prompt,
          idempotencyKey: taskScope.idempotencyKey,
        });
        return {
          task: result.task,
          taskOperation: result.operation,
          taskEventId: result.eventId,
        };
      } catch (error) {
        return {
          taskLinkError: {
            message: error instanceof Error ? error.message : String(error),
            type: error instanceof Error ? error.constructor.name : typeof error,
          },
        };
      }
    },
  };
}

async function prepareSessionCreate(
  options: CreateSessionCreateLifecycleOptions,
  input: PrepareSessionCreateInput,
): Promise<PreparedSessionCreate> {
  const body = input.body;
  const parentTaskId = optionalString(body, "parentTaskId") || undefined;
  const idempotencyKey = optionalString(body, "taskIdempotencyKey") || undefined;
  const taskScope = await prepareTaskScope(
    options.tasks,
    parentTaskId,
    idempotencyKey,
  );
  if (taskScope.existingResponse !== undefined) {
    return { payload: { ...body }, existingResponse: taskScope.existingResponse };
  }

  const payload: JsonObject = Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== null && value !== undefined),
  );
  const sourceSessionId = optionalString(body, "sourceSessionId");
  const bodyCallerInfo = optionalObject(body, "caller_info");
  const nodeId = optionalString(body, "nodeId") ?? "";
  validateOptionalContainer(body);

  let snapshot: BoardItemCatalogSnapshot | undefined;
  delete payload.sourceSessionId;
  if (sourceSessionId) {
    if (!isJsonObject(payload.container)) {
      snapshot = await options.boardItems.getCatalogSnapshot();
      const sourceItem = primarySessionBoardItem(snapshot.boardItems, sourceSessionId);
      const inherited = inheritedRunbookContainer(sourceItem);
      if (inherited !== undefined) payload.container = inherited;
    }
  }

  const accessEmail = callerInfoEmail(bodyCallerInfo);
  const access = await options.access.resolveAccess({
    request: input.request,
    accessEmail,
  });
  if (access.restricted) {
    snapshot ??= await options.boardItems.getCatalogSnapshot();
    let folderId = await resolvePayloadFolderId(options.boardItems, payload);
    if (folderId === null) {
      folderId = firstAllowedSessionFolderId(access, snapshot.folders);
      if (folderId !== null) payload.folderId = folderId;
    }
    await options.access.requireFolderAccess({
      request: input.request,
      accessEmail,
      folderId,
    });
  }

  payload.caller_info = await options.resolveCallerInfo(
    input.request,
    bodyCallerInfo,
    nodeId,
  );
  if (taskScope.context !== undefined) {
    payload.extra_context_items = [buildParentTaskContextItem(taskScope.context.parentTask)];
  }
  return {
    payload,
    ...(taskScope.context === undefined ? {} : { taskScope: taskScope.context }),
  };
}

async function prepareTaskScope(
  provider: TaskScopedSessionProvider,
  parentTaskId: string | undefined,
  idempotencyKey: string | undefined,
): Promise<{
  readonly existingResponse?: SessionCreateResponse;
  readonly context?: TaskScopeContext;
}> {
  if (parentTaskId === undefined) return {};
  if (idempotencyKey !== undefined) {
    const existing = await provider.findTaskScopedSession(idempotencyKey);
    const linkedSessionId = existing?.task?.linkedSessionId;
    if (existing !== null && typeof linkedSessionId === "string" && linkedSessionId) {
      return {
        existingResponse: {
          agentSessionId: linkedSessionId,
          nodeId: existing.task?.linkedNodeId,
          task: existing.task,
          taskOperation: existing.operation,
          taskEventId: existing.eventId,
          idempotent: true,
        },
      };
    }
  }
  const parentTask = await provider.getTask(parentTaskId);
  if (parentTask === null) {
    throw new SessionCreateLifecycleError(
      "PARENT_TASK_NOT_FOUND",
      "parent task item not found",
      404,
    );
  }
  return {
    context: {
      parentTask,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
  };
}

function primarySessionBoardItem(
  boardItems: readonly BoardItemRecord[],
  sourceSessionId: string,
): BoardItemRecord | undefined {
  return boardItems.find((item) =>
    item.itemType === "session" &&
    item.itemId === sourceSessionId &&
    (item.membershipKind ?? "primary") === "primary"
  );
}

function inheritedRunbookContainer(
  item: BoardItemRecord | undefined,
): BoardContainerTarget | undefined {
  if (item?.containerKind !== "runbook") return undefined;
  const containerId = item.containerId;
  if (typeof containerId !== "string" || containerId.length === 0) return undefined;
  return { kind: "runbook", id: containerId };
}

async function resolvePayloadFolderId(
  provider: BoardItemRouteProvider,
  payload: JsonObject,
): Promise<string | null> {
  let folderId = stringOrNull(payload.folderId);
  if (!isJsonObject(payload.container)) return folderId;
  const kind = payload.container.kind;
  const containerId = stringOrNull(payload.container.id);
  if (kind === "folder" && containerId !== null) return containerId;
  if (kind !== "runbook" || containerId === null) return folderId;
  folderId = await provider.resolveBoardContainerFolderId({
    kind: "runbook",
    id: containerId,
  });
  return folderId;
}

function buildParentTaskContextItem(parent: SerializedTaskItem): JsonObject {
  const content = [
    "Task Tree parent context.",
    "This is a normal user-started New Session scoped under the parent task, not a delegated agent task.",
    "",
    `- id: ${parent.id}`,
    `- title: ${parent.title ?? ""}`,
    `- status: ${parent.status}`,
    `- description: ${parent.description || "(empty)"}`,
    `- acceptanceCriteria: ${parent.acceptanceCriteria || "(empty)"}`,
  ].join("\n");
  return {
    key: "task_tree_parent",
    label: "Task Tree parent",
    content,
  };
}

function validateOptionalContainer(body: JsonObject): void {
  if (body.container === undefined || body.container === null) return;
  if (!isJsonObject(body.container)) {
    throw new SessionCreateLifecycleError(
      "INVALID_REQUEST",
      "container must be a JSON object or null",
      422,
    );
  }
}

function optionalObject(
  object: JsonObject,
  key: string,
): JsonObject | null | undefined {
  const value = object[key];
  if (value === undefined || value === null) return value;
  if (isJsonObject(value)) return value;
  throw new SessionCreateLifecycleError(
    "INVALID_REQUEST",
    `${key} must be a JSON object or null`,
    422,
  );
}

function optionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  throw new SessionCreateLifecycleError(
    "INVALID_REQUEST",
    `${key} must be a string or null`,
    422,
  );
}

function callerInfoEmail(callerInfo: JsonObject | null | undefined): string | null {
  return stringOrNull(callerInfo?.email);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLifecycleError(error: unknown): SessionCreateLifecycleError {
  if (error instanceof SessionCreateLifecycleError) return error;
  if (typeof error === "object" && error !== null) {
    const statusCode = "statusCode" in error ? error.statusCode : undefined;
    if (typeof statusCode === "number") {
      const code = "code" in error && typeof error.code === "string"
        ? error.code
        : "SESSION_CREATE_PREPARATION_FAILED";
      const message = error instanceof Error ? error.message : code;
      return new SessionCreateLifecycleError(code, message, statusCode);
    }
  }
  return new SessionCreateLifecycleError(
    "SESSION_CREATE_PREPARATION_FAILED",
    error instanceof Error ? error.message : String(error),
    500,
  );
}

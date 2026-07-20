import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { normalizeBoardAccess } from "../board/board_access.js";
import { filterTaskOverviewForAccess } from "./task_access.js";
import { registerTaskCreateRoute } from "./task_create_route.js";
import { registerTaskCrudRoutes } from "./task_crud_routes.js";
import {
  loadTaskSnapshot,
  proxyTaskMutation,
  requireSnapshotAccess,
  taskStorageNotConfigured,
  sendTaskRouteError,
} from "./task_mutation_proxy.js";
import { registerTaskIdentityHostRoute } from "./task_identity_host_route.js";
import { registerTaskLegacyHttpCompatibility } from "./task_legacy_http_compat.js";
import {
  resolveItemActorSessionId,
  resolveTaskActorSessionId,
  snapshotItem,
} from "./task_snapshot.js";
import {
  TaskRouteError as TaskUserStatusRouteError,
  type TaskRouteOptions,
} from "./task_route_types.js";

export { filterTaskOverviewForAccess } from "./task_access.js";
export {
  TaskRouteError,
  taskRouteAuthRequirements,
  type TaskAccess,
  type TaskAccessProvider,
  type TaskFolderRecord,
  type TaskMutationHttpClient,
  type TaskMutationHttpRequest,
  type TaskMutationHttpResponse,
  type TaskMutationNode,
  type TaskOverview,
  type TaskRouteOptions,
  type TaskRouteProvider,
  type TaskSnapshot,
  type TaskStatus,
  type TaskUserStatusMutation,
  type TaskUserStatusMutationInput,
  type TaskUserStatusMutationResult,
} from "./task_route_types.js";
export {
  createTaskUserStatusMutation,
  type CreateTaskUserStatusMutationOptions,
} from "./task_user_status_mutation.js";

type TaskParams = {
  task_id: string;
};

type TaskItemParams = {
  task_id: string;
  item_id: string;
};

type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; statusCode?: number };

const itemStatuses = ["pending", "review", "completed", "cancelled"] as const;
const taskStatuses = ["open", "completed"] as const;

export function registerTaskRoutes(
  app: FastifyInstance,
  options: TaskRouteOptions,
): void {
  registerTaskCreateRoute(app, options);
  registerTaskCrudRoutes(app, options);
  registerTaskLegacyHttpCompatibility(app, options);
  if (options.taskIdentityService && options.authBearerToken) {
    registerTaskIdentityHostRoute(app, {
      service: options.taskIdentityService,
      authBearerToken: options.authBearerToken,
    });
  }

  app.get("/api/tasks/my-turn", async (request, reply) => {
    const limit = parseLimit(request.query);
    if (!limit.ok) return validationError(reply, limit);
    if (options.provider.getTaskOverview === undefined) {
      return taskStorageNotConfigured(reply);
    }

    const folders = await options.provider.listFolders();
    const userId = await resolveDashboardUserId(options, request);
    const overview = await options.provider.getTaskOverview({
      userId,
      limit: limit.value,
    });
    const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
    return reply.send(filterTaskOverviewForAccess(overview, folders, access));
  });

  app.post<{ Params: TaskItemParams }>(
    "/api/tasks/:task_id/items/:item_id/status",
    async (request, reply) => {
      const body = parseStatusMutationBody(request.body, itemStatuses, "status");
      if (!body.ok) return validationError(reply, body);

      const params = taskItemParams(request);
      const snapshotResult = await loadTaskSnapshot(options.provider, params.task_id);
      if (!snapshotResult.ok) return sendTaskRouteError(reply, snapshotResult.error);
      const snapshot = snapshotResult.value;

      const accessResult = await requireSnapshotAccess(options, request, snapshot);
      if (!accessResult.ok) return sendTaskRouteError(reply, accessResult.error);
      if (snapshotItem(snapshot, params.item_id) === undefined) {
        return reply.code(404).send({ detail: "Task item not found" });
      }

      const actorSessionId = resolveItemActorSessionId(snapshot, params.item_id);
      if (actorSessionId === null) {
        return reply.code(422).send({
          detail: "Task item has no session provenance",
        });
      }

      return proxyTaskMutation(request, reply, options, actorSessionId, {
        upstreamPath: `/api/tasks/${encodeURIComponent(params.task_id)}/items/${encodeURIComponent(params.item_id)}/status`,
        body: body.value,
      });
    },
  );

  app.post<{ Params: TaskParams }>(
    "/api/tasks/:task_id/status",
    async (request, reply) => {
      const body = parseStatusMutationBody(request.body, taskStatuses, "status");
      if (!body.ok) return validationError(reply, body);

      const params = taskParams(request);
      const snapshotResult = await loadTaskSnapshot(options.provider, params.task_id);
      if (!snapshotResult.ok) return sendTaskRouteError(reply, snapshotResult.error);
      const snapshot = snapshotResult.value;

      const accessResult = await requireSnapshotAccess(options, request, snapshot);
      if (!accessResult.ok) return sendTaskRouteError(reply, accessResult.error);

      const actorSessionId = resolveTaskActorSessionId(snapshot);
      if (actorSessionId === null) {
        if (options.provider.setTaskStatusAsUser === undefined) {
          return reply.code(422).send({ detail: "Task has no session provenance" });
        }
        const userId = await resolveDashboardUserId(options, request);
        if (userId === null || userId.trim().length === 0) {
          return reply.code(401).send({ detail: "Authenticated user identity is required" });
        }
        try {
          return reply.send(await options.provider.setTaskStatusAsUser({
            taskId: params.task_id,
            status: body.value.status,
            expectedVersion: body.value.expectedVersion,
            idempotencyKey: body.value.idempotencyKey,
            ...(body.value.reason === undefined ? {} : { reason: body.value.reason }),
            userId: userId.trim(),
          }));
        } catch (error) {
          return sendTaskUserStatusError(reply, error);
        }
      }

      return proxyTaskMutation(request, reply, options, actorSessionId, {
        upstreamPath: `/api/tasks/${encodeURIComponent(params.task_id)}/status`,
        body: body.value,
      });
    },
  );

  app.get<{ Params: TaskParams }>(
    "/api/tasks/:task_id",
    async (request, reply) => {
      const params = taskParams(request);
      const snapshotResult = await loadTaskSnapshot(options.provider, params.task_id);
      if (!snapshotResult.ok) return sendTaskRouteError(reply, snapshotResult.error);
      const accessResult = await requireSnapshotAccess(
        options,
        request,
        snapshotResult.value,
      );
      if (!accessResult.ok) return sendTaskRouteError(reply, accessResult.error);
      return reply.send(snapshotResult.value);
    },
  );
}

function parseStatusMutationBody<
  TStatus extends readonly [string, ...string[]] | readonly string[],
>(
  body: unknown,
  allowedStatuses: TStatus,
  statusKey: string,
): Validation<{
  status: TStatus[number];
  expectedVersion: number;
  idempotencyKey: string;
  reason?: string;
}> {
  const object = parseObjectBody(body);
  if (!object.ok) return object;
  const status = requiredString(object.value, statusKey);
  if (!status.ok) return status;
  if (!allowedStatuses.includes(status.value)) {
    return {
      ok: false,
      message: `${statusKey} must be one of: ${allowedStatuses.join(", ")}`,
    };
  }
  const expectedVersion = requiredIntegerAlias(
    object.value,
    "expectedVersion",
    "expected_version",
  );
  if (!expectedVersion.ok) return expectedVersion;
  const idempotencyKey = requiredStringAlias(
    object.value,
    "idempotencyKey",
    "idempotency_key",
  );
  if (!idempotencyKey.ok) return idempotencyKey;

  const value: {
    status: TStatus[number];
    expectedVersion: number;
    idempotencyKey: string;
    reason?: string;
  } = {
    status: status.value,
    expectedVersion: expectedVersion.value,
    idempotencyKey: idempotencyKey.value,
  };
  if (object.value.reason !== undefined && object.value.reason !== null) {
    const reason = requiredString(object.value, "reason");
    if (!reason.ok) return reason;
    value.reason = reason.value;
  }
  return { ok: true, value };
}

function parseLimit(query: unknown): Validation<number> {
  const values =
    query !== null && typeof query === "object"
      ? (query as Record<string, unknown>)
      : {};
  const raw = values.limit;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return { ok: true, value: 100 };
  const parsed = typeof value === "string" ? Number(value) : value;
  if (
    typeof parsed === "number" &&
    Number.isInteger(parsed) &&
    parsed >= 1 &&
    parsed <= 500
  ) {
    return { ok: true, value: parsed };
  }
  return { ok: false, message: "limit must be an integer between 1 and 500" };
}

function parseObjectBody(body: unknown): Validation<Record<string, unknown>> {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    return { ok: true, value: body as Record<string, unknown> };
  }
  return { ok: false, message: "Request body must be a JSON object" };
}

function requiredString(
  body: Record<string, unknown>,
  key: string,
): Validation<string> {
  const value = body[key];
  if (typeof value === "string") return { ok: true, value };
  return { ok: false, message: `${key} must be a string` };
}

function requiredStringAlias(
  body: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): Validation<string> {
  const key = body[camelKey] !== undefined ? camelKey : snakeKey;
  return requiredString(body, key);
}

function requiredIntegerAlias(
  body: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): Validation<number> {
  const key = body[camelKey] !== undefined ? camelKey : snakeKey;
  const value = body[key];
  if (typeof value === "number" && Number.isInteger(value)) {
    return { ok: true, value };
  }
  return { ok: false, message: `${camelKey} must be a number` };
}

function validationError<T>(
  reply: FastifyReply,
  validation: Extract<Validation<T>, { ok: false }>,
): FastifyReply {
  return reply.code(validation.statusCode ?? 400).send({ detail: validation.message });
}

function sendTaskUserStatusError(
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (!(error instanceof TaskUserStatusRouteError)) {
    return sendTaskRouteError(reply, error);
  }
  return reply.code(error.statusCode).send({
    detail: {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
  });
}

async function resolveDashboardUserId(
  options: TaskRouteOptions,
  request: FastifyRequest,
): Promise<string | null> {
  return options.resolveDashboardUserId === undefined
    ? null
    : await options.resolveDashboardUserId(request);
}

function taskParams(request: FastifyRequest): TaskParams {
  return request.params as TaskParams;
}

function taskItemParams(request: FastifyRequest): TaskItemParams {
  return request.params as TaskItemParams;
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { normalizeBoardAccess } from "../board/board_access.js";
import { filterRunbookOverviewForAccess } from "./runbook_access.js";
import { registerRunbookCreateRoute } from "./runbook_create_route.js";
import { registerRunbookCrudRoutes } from "./runbook_crud_routes.js";
import {
  loadRunbookSnapshot,
  proxyRunbookMutation,
  requireSnapshotAccess,
  runbookStorageNotConfigured,
  sendRunbookRouteError,
} from "./runbook_mutation_proxy.js";
import { registerRunbookTaskIdentityHostRoute } from "./runbook_task_identity_host_route.js";
import {
  resolveItemActorSessionId,
  resolveRunbookActorSessionId,
  snapshotItem,
} from "./runbook_snapshot.js";
import {
  type RunbookRouteOptions,
} from "./runbook_route_types.js";

export { filterRunbookOverviewForAccess } from "./runbook_access.js";
export {
  RunbookRouteError,
  runbookRouteAuthRequirements,
  type RunbookAccess,
  type RunbookAccessProvider,
  type RunbookFolderRecord,
  type RunbookMutationHttpClient,
  type RunbookMutationHttpRequest,
  type RunbookMutationHttpResponse,
  type RunbookMutationNode,
  type RunbookOverview,
  type RunbookRouteOptions,
  type RunbookRouteProvider,
  type RunbookSnapshot,
} from "./runbook_route_types.js";

type RunbookParams = {
  runbook_id: string;
};

type RunbookItemParams = {
  runbook_id: string;
  item_id: string;
};

type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; statusCode?: number };

const itemStatuses = ["pending", "review", "completed", "cancelled"] as const;
const runbookStatuses = ["open", "completed"] as const;

export function registerRunbookRoutes(
  app: FastifyInstance,
  options: RunbookRouteOptions,
): void {
  registerRunbookCreateRoute(app, options);
  registerRunbookCrudRoutes(app, options);
  if (options.taskIdentityService && options.authBearerToken) {
    registerRunbookTaskIdentityHostRoute(app, {
      service: options.taskIdentityService,
      authBearerToken: options.authBearerToken,
    });
  }

  app.get("/api/runbooks/my-turn", async (request, reply) => {
    const limit = parseLimit(request.query);
    if (!limit.ok) return validationError(reply, limit);
    if (options.provider.getRunbookOverview === undefined) {
      return runbookStorageNotConfigured(reply);
    }

    const folders = await options.provider.listFolders();
    const userId = await resolveDashboardUserId(options, request);
    const overview = await options.provider.getRunbookOverview({
      userId,
      limit: limit.value,
    });
    const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
    return reply.send(filterRunbookOverviewForAccess(overview, folders, access));
  });

  app.post<{ Params: RunbookItemParams }>(
    "/api/runbooks/:runbook_id/items/:item_id/status",
    async (request, reply) => {
      const body = parseStatusMutationBody(request.body, itemStatuses, "status");
      if (!body.ok) return validationError(reply, body);

      const params = runbookItemParams(request);
      const snapshotResult = await loadRunbookSnapshot(options.provider, params.runbook_id);
      if (!snapshotResult.ok) return sendRunbookRouteError(reply, snapshotResult.error);
      const snapshot = snapshotResult.value;

      const accessResult = await requireSnapshotAccess(options, request, snapshot);
      if (!accessResult.ok) return sendRunbookRouteError(reply, accessResult.error);
      if (snapshotItem(snapshot, params.item_id) === undefined) {
        return reply.code(404).send({ detail: "Runbook item not found" });
      }

      const actorSessionId = resolveItemActorSessionId(snapshot, params.item_id);
      if (actorSessionId === null) {
        return reply.code(422).send({
          detail: "Runbook item has no session provenance",
        });
      }

      return proxyRunbookMutation(request, reply, options, actorSessionId, {
        upstreamPath: `/api/runbooks/${encodeURIComponent(params.runbook_id)}/items/${encodeURIComponent(params.item_id)}/status`,
        body: body.value,
      });
    },
  );

  app.post<{ Params: RunbookParams }>(
    "/api/runbooks/:runbook_id/status",
    async (request, reply) => {
      const body = parseStatusMutationBody(request.body, runbookStatuses, "status");
      if (!body.ok) return validationError(reply, body);

      const params = runbookParams(request);
      const snapshotResult = await loadRunbookSnapshot(options.provider, params.runbook_id);
      if (!snapshotResult.ok) return sendRunbookRouteError(reply, snapshotResult.error);
      const snapshot = snapshotResult.value;

      const accessResult = await requireSnapshotAccess(options, request, snapshot);
      if (!accessResult.ok) return sendRunbookRouteError(reply, accessResult.error);

      const actorSessionId = resolveRunbookActorSessionId(snapshot);
      if (actorSessionId === null) {
        return reply.code(422).send({ detail: "Runbook has no session provenance" });
      }

      return proxyRunbookMutation(request, reply, options, actorSessionId, {
        upstreamPath: `/api/runbooks/${encodeURIComponent(params.runbook_id)}/status`,
        body: body.value,
      });
    },
  );

  app.get<{ Params: RunbookParams }>(
    "/api/runbooks/:runbook_id",
    async (request, reply) => {
      const params = runbookParams(request);
      const snapshotResult = await loadRunbookSnapshot(options.provider, params.runbook_id);
      if (!snapshotResult.ok) return sendRunbookRouteError(reply, snapshotResult.error);
      const accessResult = await requireSnapshotAccess(
        options,
        request,
        snapshotResult.value,
      );
      if (!accessResult.ok) return sendRunbookRouteError(reply, accessResult.error);
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

async function resolveDashboardUserId(
  options: RunbookRouteOptions,
  request: FastifyRequest,
): Promise<string | null> {
  return options.resolveDashboardUserId === undefined
    ? null
    : await options.resolveDashboardUserId(request);
}

function runbookParams(request: FastifyRequest): RunbookParams {
  return request.params as RunbookParams;
}

function runbookItemParams(request: FastifyRequest): RunbookItemParams {
  return request.params as RunbookItemParams;
}

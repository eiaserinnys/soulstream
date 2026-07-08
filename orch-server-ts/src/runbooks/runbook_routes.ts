import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { isBoardFolderAllowed, normalizeBoardAccess } from "../board/board_access.js";
import { filterRunbookOverviewForAccess } from "./runbook_access.js";
import {
  resolveItemActorSessionId,
  resolveRunbookActorSessionId,
  snapshotItem,
  snapshotRunbookFolderId,
} from "./runbook_snapshot.js";
import {
  RunbookRouteError,
  type RunbookMutationHttpResponse,
  type RunbookMutationNode,
  type RunbookRouteOptions,
  type RunbookRouteProvider,
  type RunbookSnapshot,
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

async function loadRunbookSnapshot(
  provider: RunbookRouteProvider,
  runbookId: string,
): Promise<
  | { ok: true; value: RunbookSnapshot }
  | { ok: false; error: RunbookRouteError }
> {
  if (provider.getRunbookSnapshot === undefined) {
    return {
      ok: false,
      error: storageNotConfiguredError(),
    };
  }
  const snapshot = await provider.getRunbookSnapshot(runbookId);
  if (snapshot === undefined || snapshot === null) {
    return {
      ok: false,
      error: new RunbookRouteError(
        "RUNBOOK_NOT_FOUND",
        "Runbook not found",
        404,
      ),
    };
  }
  return { ok: true, value: snapshot };
}

async function requireSnapshotAccess(
  options: RunbookRouteOptions,
  request: FastifyRequest,
  snapshot: RunbookSnapshot,
): Promise<{ ok: true } | { ok: false; error: RunbookRouteError }> {
  const folders = await options.provider.listFolders();
  const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
  if (!isBoardFolderAllowed(access, folders, snapshotRunbookFolderId(snapshot))) {
    return {
      ok: false,
      error: new RunbookRouteError(
        "FOLDER_ACCESS_DENIED",
        "Folder access denied",
        403,
      ),
    };
  }
  return { ok: true };
}

async function proxyRunbookMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  options: RunbookRouteOptions,
  actorSessionId: string,
  input: { upstreamPath: string; body: unknown },
): Promise<FastifyReply> {
  const targetResult = await resolveRunbookMutationNode(options.provider, actorSessionId);
  if (!targetResult.ok) return sendRunbookRouteError(reply, targetResult.error);

  try {
    const response = await options.httpClient({
      method: "POST",
      url: `http://${targetResult.value.host}:${targetResult.value.port}${input.upstreamPath}`,
      upstreamPath: input.upstreamPath,
      headers: forwardRunbookAuthHeaders(request),
      body: input.body,
      target: targetResult.value,
    });
    return sendRunbookNodeResponse(reply, response);
  } catch {
    return reply.code(502).send();
  }
}

async function resolveRunbookMutationNode(
  provider: RunbookRouteProvider,
  actorSessionId: string,
): Promise<
  | { ok: true; value: RunbookMutationNode }
  | { ok: false; error: RunbookRouteError }
> {
  if (provider.findSessionNode === undefined || provider.listConnectedNodes === undefined) {
    return { ok: false, error: storageNotConfiguredError() };
  }
  try {
    const node = await provider.findSessionNode(actorSessionId);
    if (node !== undefined && node !== null) return { ok: true, value: node };
  } catch (error) {
    const statusCode = errorStatusCode(error);
    if (statusCode !== 404 && statusCode !== 503) {
      return { ok: false, error: routeErrorFromUnknown(error, 500) };
    }
  }

  const fallback = provider.listConnectedNodes()[0];
  if (fallback === undefined) {
    return {
      ok: false,
      error: new RunbookRouteError(
        "RUNBOOK_MUTATION_NODE_UNAVAILABLE",
        "No connected soul-server node available for runbook mutation",
        503,
      ),
    };
  }
  return { ok: true, value: fallback };
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

function runbookStorageNotConfigured(reply: FastifyReply): FastifyReply {
  return sendRunbookRouteError(reply, storageNotConfiguredError());
}

function storageNotConfiguredError(): RunbookRouteError {
  return new RunbookRouteError(
    "RUNBOOK_STORAGE_NOT_CONFIGURED",
    "Runbook storage is not configured",
    503,
  );
}

function sendRunbookRouteError(
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  const routeError = routeErrorFromUnknown(error, 500);
  return reply.code(routeError.statusCode).send({ detail: routeError.message });
}

function routeErrorFromUnknown(error: unknown, fallbackStatusCode: number): RunbookRouteError {
  if (error instanceof RunbookRouteError) return error;
  const statusCode = errorStatusCode(error) ?? fallbackStatusCode;
  const message = error instanceof Error ? error.message : String(error);
  return new RunbookRouteError("RUNBOOK_ROUTE_ERROR", message, statusCode);
}

function errorStatusCode(error: unknown): number | undefined {
  if (error instanceof RunbookRouteError) return error.statusCode;
  if (isRecord(error) && typeof error.statusCode === "number") return error.statusCode;
  if (isRecord(error) && typeof error.status_code === "number") return error.status_code;
  return undefined;
}

function sendRunbookNodeResponse(
  reply: FastifyReply,
  response: RunbookMutationHttpResponse,
): FastifyReply {
  const contentType = headerValue(response.headers, "content-type");
  if (contentType !== undefined) reply.header("content-type", contentType);
  if (isJsonContentType(contentType)) {
    return reply.code(response.statusCode).send(response.body ?? null);
  }
  if (response.body === undefined) return reply.code(response.statusCode).send();
  return reply.code(response.statusCode).send(response.body);
}

function forwardRunbookAuthHeaders(request: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  const cookie = firstHeaderValue(request.headers.cookie);
  if (cookie !== undefined) headers.cookie = cookie;
  const authorization = firstHeaderValue(request.headers.authorization);
  if (authorization !== undefined) headers.authorization = authorization;
  return headers;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function headerValue(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  const targetName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === targetName) return value;
  }
  return undefined;
}

function isJsonContentType(contentType: string | undefined): boolean {
  return contentType?.toLowerCase().includes("application/json") ?? false;
}

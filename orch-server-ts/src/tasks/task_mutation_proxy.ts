import type { FastifyReply, FastifyRequest } from "fastify";

import { isBoardFolderAllowed, normalizeBoardAccess } from "../board/board_access.js";
import { snapshotTaskFolderId } from "./task_snapshot.js";
import {
  TaskRouteError,
  type TaskMutationHttpResponse,
  type TaskMutationNode,
  type TaskRouteOptions,
  type TaskRouteProvider,
  type TaskSnapshot,
} from "./task_route_types.js";

export async function loadTaskSnapshot(
  provider: TaskRouteProvider,
  taskId: string,
): Promise<
  | { ok: true; value: TaskSnapshot }
  | { ok: false; error: TaskRouteError }
> {
  if (provider.getTaskSnapshot === undefined) {
    return { ok: false, error: storageNotConfiguredError() };
  }
  const snapshot = await provider.getTaskSnapshot(taskId);
  if (snapshot === undefined || snapshot === null) {
    return {
      ok: false,
      error: new TaskRouteError("TASK_NOT_FOUND", "Task not found", 404),
    };
  }
  return { ok: true, value: snapshot };
}

export async function requireSnapshotAccess(
  options: TaskRouteOptions,
  request: FastifyRequest,
  snapshot: TaskSnapshot,
): Promise<{ ok: true } | { ok: false; error: TaskRouteError }> {
  const folders = await options.provider.listFolders();
  const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
  if (!isBoardFolderAllowed(access, folders, snapshotTaskFolderId(snapshot))) {
    return {
      ok: false,
      error: new TaskRouteError("FOLDER_ACCESS_DENIED", "Folder access denied", 403),
    };
  }
  return { ok: true };
}

export async function proxyTaskMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  options: TaskRouteOptions,
  actorSessionId: string,
  input: { upstreamPath: string; body: unknown },
): Promise<FastifyReply> {
  const targetResult = await resolveTaskMutationNode(options.provider, actorSessionId);
  if (!targetResult.ok) return sendTaskRouteError(reply, targetResult.error);

  try {
    const response = await options.httpClient({
      method: "POST",
      url: `http://${targetResult.value.host}:${targetResult.value.port}${input.upstreamPath}`,
      upstreamPath: input.upstreamPath,
      headers: forwardTaskAuthHeaders(request),
      body: input.body,
      target: targetResult.value,
    });
    return sendTaskNodeResponse(reply, response);
  } catch {
    return reply.code(502).send();
  }
}

export function sendTaskRouteError(
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  const routeError = routeErrorFromUnknown(error, 500);
  return reply.code(routeError.statusCode).send({ detail: routeError.message });
}

export function taskStorageNotConfigured(reply: FastifyReply): FastifyReply {
  return sendTaskRouteError(reply, storageNotConfiguredError());
}

async function resolveTaskMutationNode(
  provider: TaskRouteProvider,
  actorSessionId: string,
): Promise<
  | { ok: true; value: TaskMutationNode }
  | { ok: false; error: TaskRouteError }
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
      error: new TaskRouteError(
        "TASK_MUTATION_NODE_UNAVAILABLE",
        "No connected soul-server node available for task mutation",
        503,
      ),
    };
  }
  return { ok: true, value: fallback };
}

function storageNotConfiguredError(): TaskRouteError {
  return new TaskRouteError(
    "TASK_STORAGE_NOT_CONFIGURED",
    "Task storage is not configured",
    503,
  );
}

function routeErrorFromUnknown(error: unknown, fallbackStatusCode: number): TaskRouteError {
  if (error instanceof TaskRouteError) return error;
  const statusCode = errorStatusCode(error) ?? fallbackStatusCode;
  const message = error instanceof Error ? error.message : String(error);
  return new TaskRouteError("TASK_ROUTE_ERROR", message, statusCode);
}

function errorStatusCode(error: unknown): number | undefined {
  if (error instanceof TaskRouteError) return error.statusCode;
  if (isRecord(error) && typeof error.statusCode === "number") return error.statusCode;
  if (isRecord(error) && typeof error.status_code === "number") return error.status_code;
  return undefined;
}

function sendTaskNodeResponse(
  reply: FastifyReply,
  response: TaskMutationHttpResponse,
): FastifyReply {
  const contentType = headerValue(response.headers, "content-type");
  if (contentType !== undefined) reply.header("content-type", contentType);
  if (contentType?.toLowerCase().includes("application/json")) {
    return reply.code(response.statusCode).send(response.body ?? null);
  }
  if (response.body === undefined) return reply.code(response.statusCode).send();
  return reply.code(response.statusCode).send(response.body);
}

function forwardTaskAuthHeaders(request: FastifyRequest): Record<string, string> {
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

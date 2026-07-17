import type { FastifyReply, FastifyRequest } from "fastify";

import { isBoardFolderAllowed, normalizeBoardAccess } from "../board/board_access.js";
import { snapshotRunbookFolderId } from "./runbook_snapshot.js";
import {
  RunbookRouteError,
  type RunbookMutationHttpResponse,
  type RunbookMutationNode,
  type RunbookRouteOptions,
  type RunbookRouteProvider,
  type RunbookSnapshot,
} from "./runbook_route_types.js";

export async function loadRunbookSnapshot(
  provider: RunbookRouteProvider,
  runbookId: string,
): Promise<
  | { ok: true; value: RunbookSnapshot }
  | { ok: false; error: RunbookRouteError }
> {
  if (provider.getRunbookSnapshot === undefined) {
    return { ok: false, error: storageNotConfiguredError() };
  }
  const snapshot = await provider.getRunbookSnapshot(runbookId);
  if (snapshot === undefined || snapshot === null) {
    return {
      ok: false,
      error: new RunbookRouteError("RUNBOOK_NOT_FOUND", "Runbook not found", 404),
    };
  }
  return { ok: true, value: snapshot };
}

export async function requireSnapshotAccess(
  options: RunbookRouteOptions,
  request: FastifyRequest,
  snapshot: RunbookSnapshot,
): Promise<{ ok: true } | { ok: false; error: RunbookRouteError }> {
  const folders = await options.provider.listFolders();
  const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
  if (!isBoardFolderAllowed(access, folders, snapshotRunbookFolderId(snapshot))) {
    return {
      ok: false,
      error: new RunbookRouteError("FOLDER_ACCESS_DENIED", "Folder access denied", 403),
    };
  }
  return { ok: true };
}

export async function proxyRunbookMutation(
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

export function sendRunbookRouteError(
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  const routeError = routeErrorFromUnknown(error, 500);
  return reply.code(routeError.statusCode).send({ detail: routeError.message });
}

export function runbookStorageNotConfigured(reply: FastifyReply): FastifyReply {
  return sendRunbookRouteError(reply, storageNotConfiguredError());
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

function storageNotConfiguredError(): RunbookRouteError {
  return new RunbookRouteError(
    "RUNBOOK_STORAGE_NOT_CONFIGURED",
    "Runbook storage is not configured",
    503,
  );
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
  if (contentType?.toLowerCase().includes("application/json")) {
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

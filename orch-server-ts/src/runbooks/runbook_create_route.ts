import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { isBoardFolderAllowed, normalizeBoardAccess } from "../board/board_access.js";
import type {
  RunbookMutationHttpResponse,
  RunbookRouteOptions,
} from "./runbook_route_types.js";

interface CreateRunbookBody {
  runbook_id?: string;
  title: string;
  folder_id: string;
}

export function registerRunbookCreateRoute(
  app: FastifyInstance,
  options: RunbookRouteOptions,
): void {
  app.post("/api/runbooks", async (request, reply) => {
    const body = parseCreateRunbookBody(request.body);
    if (!body.ok) return reply.code(400).send({ detail: body.message });

    const folders = await options.provider.listFolders();
    if (!folders.some((folder) => folder.id === body.value.folder_id)) {
      return reply.code(404).send({ detail: "Folder not found" });
    }
    const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
    if (!isBoardFolderAllowed(access, folders, body.value.folder_id)) {
      return reply.code(403).send({ detail: "Folder access denied" });
    }
    const target = options.provider.listConnectedNodes?.()[0];
    if (!target) {
      return reply.code(503).send({
        detail: "No connected soul-server node available for runbook mutation",
      });
    }
    try {
      const response = await options.httpClient({
        method: "POST",
        url: `http://${target.host}:${target.port}/api/runbooks`,
        upstreamPath: "/api/runbooks",
        headers: forwardAuthHeaders(request),
        body: body.value,
        target,
      });
      return sendNodeResponse(reply, response);
    } catch {
      return reply.code(502).send();
    }
  });
}

function parseCreateRunbookBody(body: unknown):
  | { ok: true; value: CreateRunbookBody }
  | { ok: false; message: string } {
  if (!isRecord(body)) return { ok: false, message: "request body must be an object" };
  const title = nonEmptyString(body.title, "title");
  if (!title.ok) return title;
  const folderId = nonEmptyString(body.folder_id, "folder_id");
  if (!folderId.ok) return folderId;
  if (body.runbook_id === undefined) {
    return { ok: true, value: { title: title.value, folder_id: folderId.value } };
  }
  const runbookId = nonEmptyString(body.runbook_id, "runbook_id");
  if (!runbookId.ok) return runbookId;
  return {
    ok: true,
    value: {
      runbook_id: runbookId.value,
      title: title.value,
      folder_id: folderId.value,
    },
  };
}

function nonEmptyString(value: unknown, key: string):
  | { ok: true; value: string }
  | { ok: false; message: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, message: `${key} must be a non-empty string` };
  }
  return { ok: true, value: value.trim() };
}

function sendNodeResponse(
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

function forwardAuthHeaders(request: FastifyRequest): Record<string, string> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

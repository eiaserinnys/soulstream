import type { FastifyInstance, FastifyReply } from "fastify";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { FolderControlPlaneService } from "./folder_control_plane_service.js";

export interface FolderControlPlaneHostRouteOptions {
  serviceProvider: () => Promise<FolderControlPlaneService>;
  authBearerToken: string;
}

const operations = new Set([
  "assign_session",
  "get_default",
  "get_folder",
  "get_all",
  "get_catalog",
  "get_session_assignments",
  "update",
]);

const updateColumns = new Set(["name", "sort_order", "settings", "parent_folder_id"]);

export function registerFolderControlPlaneHostRoute(
  app: FastifyInstance,
  options: FolderControlPlaneHostRouteOptions,
): void {
  app.post<{ Params: { operation: string } }>(
    "/api/folders/host/:operation",
    async (request, reply) => {
      const authorization = verifyServiceBearerAuthorization(
        request.headers.authorization,
        options.authBearerToken,
      );
      if (!authorization.ok) {
        return errorReply(reply, 401, "UNAUTHORIZED", `bearer token is ${authorization.reason}`);
      }
      const body = record(request.body);
      if (!body) return errorReply(reply, 422, "INVALID_FOLDER_REQUEST", "body must be an object");
      const operation = request.params.operation;
      if (!operations.has(operation)) {
        return errorReply(reply, 404, "FOLDER_OPERATION_NOT_FOUND", `unknown operation: ${operation}`);
      }
      try {
        const service = await options.serviceProvider();
        const result = await dispatch(service, operation, body);
        return reply.send(result ?? null);
      } catch (error) {
        request.log.error({ err: error }, "Folder control-plane host operation failed");
        return errorReply(
          reply,
          errorStatus(error),
          errorStatus(error) === 422 ? "INVALID_FOLDER_REQUEST" : "FOLDER_OPERATION_FAILED",
          error instanceof Error ? error.message : "Folder control-plane host operation failed",
        );
      }
    },
  );
}

async function dispatch(
  service: FolderControlPlaneService,
  operation: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  switch (operation) {
    case "assign_session":
      return await service.assignSessionToFolder(requiredString(body, "session_id"), nullableString(body, "folder_id"));
    case "get_default": return await service.getDefaultFolder(requiredString(body, "name"));
    case "get_folder": return await service.getFolderById(requiredString(body, "folder_id"));
    case "get_all": return await service.getAllFolders();
    case "get_catalog": return await service.getCatalog();
    case "get_session_assignments":
      return await service.getSessionAssignmentsByIds(stringArray(body, "session_ids"));
    case "update":
      validateUpdate(body);
      return await service.updateFolder(
        requiredString(body, "folder_id"),
        stringArray(body, "columns") as Array<"name" | "sort_order" | "settings" | "parent_folder_id">,
        nullableStringArray(body, "values"),
      );
    default: throw statusError(404, `unknown operation: ${operation}`);
  }
}

function validateUpdate(body: Record<string, unknown>): void {
  const columns = stringArray(body, "columns");
  const values = nullableStringArray(body, "values");
  if (columns.length !== values.length) {
    throw statusError(422, "columns and values must have the same length");
  }
  const unknown = columns.find((column) => !updateColumns.has(column));
  if (unknown !== undefined) throw statusError(422, `unsupported folder column: ${unknown}`);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw statusError(422, `${key} is required`);
  return value;
}
function nullableString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === null) return null;
  return requiredString(body, key);
}
function stringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw statusError(422, `${key} must be a string array`);
  }
  return value;
}
function nullableStringArray(body: Record<string, unknown>, key: string): Array<string | null> {
  const value = body[key];
  if (!Array.isArray(value) || !value.every((entry) => entry === null || typeof entry === "string")) {
    throw statusError(422, `${key} must be a nullable string array`);
  }
  return value;
}
function statusError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
function errorStatus(error: unknown): number {
  if (error !== null && typeof error === "object" && "statusCode" in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number") return statusCode;
  }
  return 500;
}
function errorReply(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ detail: { error: { code, message } } });
}

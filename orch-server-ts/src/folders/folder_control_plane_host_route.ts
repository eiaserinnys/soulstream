import { z } from "zod";
import type { ChecklistControlPlaneService } from "../checklist/checklist_control_plane_service.js";
import type { FolderActorParams } from "../checklist/control_plane/checklist_types.js";
import type { FolderProjectIdentityService } from "./folder_project_identity_service.js";
import { executeFolderOperation, folderOperationSchemas, readFolderSnapshot, type FolderOperation } from "./folder_operations.js";
import { serializeChecklistRow, serializeFolder } from "./folder_contracts.js";
import { folderOperationError } from "./folder_workspace_routes.js";
import type { FastifyInstance, FastifyReply } from "fastify";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type { FolderControlPlaneService } from "./folder_control_plane_service.js";

export interface FolderControlPlaneHostRouteOptions {
  serviceProvider: () => Promise<FolderControlPlaneService>;
  checklistServiceProvider?: () => Promise<ChecklistControlPlaneService>;
  identity?: Pick<FolderProjectIdentityService, "create" | "mutateFromFolder">;
  authBearerToken: string;
  environment?: string;
}

const operations = new Set([
  "assign_session",
  "get_default",
  "get_folder",
  "get_all",
  "get_catalog",
  "get_session_assignments",
  "list_child_folders", "list_folder_operations", "list_my_turn_items", "list_agent_subscribers",
  ...Object.keys(folderOperationSchemas),
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
        options.environment,
      );
      if (!authorization.ok) {
        return errorReply(reply, authorization.statusCode, "UNAUTHORIZED", `bearer token is ${authorization.reason}`);
      }
      const body = record(request.body);
      if (!body) return errorReply(reply, 422, "INVALID_FOLDER_REQUEST", "body must be an object");
      const operation = request.params.operation;
      if (!operations.has(operation)) {
        return errorReply(reply, 404, "FOLDER_OPERATION_NOT_FOUND", `unknown operation: ${operation}`);
      }
      try {
        const service = await options.serviceProvider();
        const result = ["assign_session", "get_default", "get_all", "get_catalog", "get_session_assignments"].includes(operation)
          ? await dispatch(service, operation, body)
          : await dispatchWorkspace(options, operation, body);
        return reply.send(result ?? null);
      } catch (error) {
        return folderOperationError(reply, error);
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
    case "get_all": return await service.getAllFolders();
    case "get_catalog": return await service.getCatalog();
    case "get_session_assignments":
      return await service.getSessionAssignmentsByIds(stringArray(body, "session_ids"));
    default: throw statusError(404, `unknown operation: ${operation}`);
  }
}

async function dispatchWorkspace(options: FolderControlPlaneHostRouteOptions, operation: string, body: Record<string, unknown>) {
  if (!options.checklistServiceProvider) throw new Error("Checklist service is not configured");
  const service = await options.checklistServiceProvider();
  if (operation === "get_folder") return await readFolderSnapshot(service, requiredString(body, "folder_id"), body.item_id as string | undefined, body.view as string | undefined);
  if (operation === "list_child_folders" || operation === "list_folder_operations") {
    const limit = z.number().int().min(1).max(200).parse(body.limit ?? 50);
    const offset = z.coerce.number().int().nonnegative().parse(body.cursor ?? 0);
    const folderId = operation === "list_child_folders" ? nullableString(body, "folder_id") : requiredString(body, "folder_id");
    const rows = operation === "list_child_folders"
      ? await service.listFolders({ folderId, includeArchived: body.include_archived === true, limit: limit + 1, offset })
      : await service.listOperations(folderId!, limit + 1, offset);
    return { items: rows.slice(0, limit).map(serializeChecklistRow), nextCursor: rows.length > limit ? String(offset + limit) : null };
  }
  if (operation === "list_agent_subscribers") return await service.listAgentSubscriberSessionIds(requiredString(body, "folder_id"));
  if (operation === "list_my_turn_items") return (await service.listMyTurnItems({ userId: body.user_id as string | undefined, limit: body.limit as number | undefined })).map(serializeChecklistRow);
  if (!options.identity) throw new Error("Folder identity is not configured");
  const kind = requiredString(body, "actor_kind");
  if (!["agent", "user", "system", "llm"].includes(kind)) throw statusError(422, "Invalid actor_kind");
  const actor: FolderActorParams = {
    actorKind: kind as FolderActorParams["actorKind"],
    actorSessionId: typeof body.actor_session_id === "string" ? body.actor_session_id : null,
    actorUserId: typeof body.actor_user_id === "string" ? body.actor_user_id : null,
  };
  if (kind === "agent" && !actor.actorSessionId) throw statusError(422, "actor_session_id is required");
  if (kind === "user" && !actor.actorUserId) throw statusError(422, "actor_user_id is required");
  const { folder_id, section_id, item_id, actor_kind, actor_session_id, actor_event_id, actor_user_id, ...payload } = body;
  if (operation === "create_folder" && folder_id !== undefined) throw statusError(422, "create_folder does not accept folder_id");
  const input = camelize(operation === "move_checklist_item" ? { ...payload, section_id } : payload);
  return await executeFolderOperation({ identity: options.identity, checklist: service }, operation as FolderOperation, input, {
    folderId: folder_id as string | undefined, sectionId: section_id as string | undefined, itemId: item_id as string | undefined,
  }, actor);
}

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  const object = record(value);
  return object ? Object.fromEntries(Object.entries(object).map(([key, child]) => [
    key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()), key === "settings" ? child : camelize(child),
  ])) : value;
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

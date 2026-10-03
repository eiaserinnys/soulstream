import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { FolderActorParams } from "../cards/control_plane/card_types.js";
import { CardVersionConflict } from "../cards/control_plane/card_models.js";
import type { FolderRouteOptions } from "./folder_routes.js";
import { isFolderAllowed, normalizeAccess } from "./folder_route_access.js";
import { executeFolderOperation, readFolderSnapshot, type FolderOperation } from "./folder_operations.js";
import { serializeCardRow, serializeFolder } from "./folder_contracts.js";

type Scope = { folder_id: string };
const mutations: readonly ["POST" | "PUT", string, FolderOperation][] = [
  ["POST", "/api/folders", "create_folder"],
  ["PUT", "/api/folders/:folder_id", "rename_folder"],
  ["POST", "/api/folders/:folder_id/archive", "archive_folder"],
  ["POST", "/api/folders/:folder_id/unarchive", "unarchive_folder"],
  ["POST", "/api/folders/:folder_id/status", "set_folder_status"],

];

export const folderWorkspaceRouteAuthRequirements: Record<string, boolean> = Object.fromEntries([
  ...mutations.map(([method, path]) => [`${method} ${path}`, true]),
  ...["", "/children", "/operations"].map((suffix) => [`GET /api/folders/:folder_id${suffix}`, true]),
]);

export function registerFolderWorkspaceRoutes(app: FastifyInstance, options: FolderRouteOptions) {
  for (const [method, url, operation] of mutations) {
    app.route<{ Params: Scope }>({ method, url, handler: async (request, reply) => {
      try {
        const body = request.body as Record<string, unknown> | undefined;
        const folderId = request.params.folder_id;
        if (!await allowed(request, options, folderId ?? (body?.parentFolderId as string | null) ?? null)) {
          return failure(reply, 403, "FOLDER_ACCESS_DENIED", "Folder access denied");
        }
        if (body && Object.hasOwn(body, "parentFolderId") &&
            !await allowed(request, options, body.parentFolderId as string | null)) {
          return failure(reply, 403, "FOLDER_ACCESS_DENIED", "Parent folder access denied");
        }
        if (!options.projectIdentityService || !options.cardServiceProvider) throw new Error("Folder services are not configured");
        const actor = await dashboardFolderActor(request, options);
        const result = await executeFolderOperation({
          identity: options.projectIdentityService,
          cards: await options.cardServiceProvider(),
        }, operation, body, {
          folderId,
        }, actor);
        return reply.code(operation === "create_folder" ? 201 : 200).send(result);
      } catch (error) { return folderOperationError(reply, error); }
    } });
  }
  for (const kind of ["snapshot", "children", "operations"] as const) {
    const path = `/api/folders/:folder_id${kind === "snapshot" ? "" : `/${kind}`}`;
    app.get<{ Params: Scope; Querystring: { view?: string; cardId?: string; limit?: string; cursor?: string; includeArchived?: string; includeCompleted?: string } }>(path, async (request, reply) => {
      try {
        const folderId = request.params.folder_id;
        if (!await allowed(request, options, folderId)) return failure(reply, 403, "FOLDER_ACCESS_DENIED", "Folder access denied");
        if (!options.cardServiceProvider) throw new Error("Folder service is not configured");
        const service = await options.cardServiceProvider();
        if (kind === "snapshot") return reply.send(await readFolderSnapshot(
          service, folderId, request.query.cardId, request.query.view, request.query.includeCompleted !== "false",
          { includeArchived: request.query.includeArchived, limit: request.query.limit, cursor: request.query.cursor },
        ));
        const limit = z.coerce.number().int().min(1).max(200).parse(request.query.limit ?? 50);
        const offset = z.coerce.number().int().nonnegative().parse(request.query.cursor ?? 0);
        const includeArchived = z.enum(["true", "false"]).parse(request.query.includeArchived ?? "false") === "true";
        if (kind === "children") {
          const rows = await service.listFolders({ folderId, limit: limit + 1, offset, includeArchived });
          return reply.send({ items: rows.slice(0, limit).map(serializeFolder), nextCursor: rows.length > limit ? String(offset + limit) : null });
        }
        const rows = await service.listOperations(folderId, limit + 1, offset);
        return reply.send({ items: rows.slice(0, limit).map(serializeCardRow), nextCursor: rows.length > limit ? String(offset + limit) : null });
      } catch (error) { return folderOperationError(reply, error); }
    });
  }
}

async function allowed(request: FastifyRequest, options: FolderRouteOptions, folderId: string | null) {
  return isFolderAllowed(normalizeAccess(await options.accessProvider.resolveAccess(request)), await options.provider.listFolders(), folderId);
}

export async function dashboardFolderActor(request: FastifyRequest, options: FolderRouteOptions): Promise<FolderActorParams> {
  const userId = await options.resolveDashboardUserId?.(request) ?? null;
  if (!userId) throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
  return { actorKind: "user", actorSessionId: null, actorUserId: userId };
}

export function folderOperationError(reply: FastifyReply, error: unknown) {
  const failure = describeFolderOperationError(error);
  return reply.code(failure.status).send({ detail: { error: { code: failure.code, message: failure.message } } });
}

export function describeFolderOperationError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ZodError) return { status: 422, code: "INVALID_FOLDER_REQUEST", message: error.message };
  if (error instanceof CardVersionConflict) {
    return { status: 409, code: error.targetKind === "folder" ? "FOLDER_VERSION_CONFLICT" : "CARD_VERSION_CONFLICT", message: error.message };
  }
  return {
    status: (error as { statusCode?: number })?.statusCode ?? 500,
    code: (error as { code?: string })?.code ?? "FOLDER_OPERATION_FAILED",
    message: error instanceof Error ? error.message : "Folder operation failed",
  };
}

function failure(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ detail: { error: { code, message } } });
}

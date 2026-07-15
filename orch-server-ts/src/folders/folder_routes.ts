import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { PageMutationActor } from "../page/page_mutation_core.js";
import {
  accessPayload,
  filterFolders,
  filterSessionAssignments,
  isFolderAllowed,
  normalizeAccess,
  type FolderAccess,
  type FolderRecord,
  type SessionAssignmentRecord,
} from "./folder_route_access.js";
import { registerFolderProjectIdentityHostRoute } from "./folder_project_identity_host_route.js";
import type { FolderProjectIdentityService } from "./folder_project_identity_service.js";

export type { FolderAccess, FolderRecord, SessionAssignmentRecord } from "./folder_route_access.js";

export type FolderCreateOptions = {
  parentFolderId: string | null;
};

export type FolderUpdateInput = {
  name?: string | null;
  sortOrder?: number | null;
  settings?: Record<string, unknown> | null;
  parentFolderId?: string | null;
};

export type FolderReorderInput = {
  id: string;
  sortOrder: number;
  parentFolderId?: string | null;
};

export type FolderRouteProvider = {
  listFolders: () => Promise<readonly FolderRecord[]> | readonly FolderRecord[];
  listSessionAssignments: () =>
    | Promise<Record<string, SessionAssignmentRecord>>
    | Record<string, SessionAssignmentRecord>;
  createFolder: (
    name: string,
    sortOrder: number,
    options: FolderCreateOptions,
  ) => Promise<unknown> | unknown;
  updateFolder: (folderId: string, update: FolderUpdateInput) => Promise<void> | void;
  deleteFolder: (folderId: string) => Promise<void> | void;
  reorderFolders: (items: FolderReorderInput[]) => Promise<void> | void;
};

export type FolderAccessProvider = {
  resolveAccess: (request: FastifyRequest) => Promise<FolderAccess> | FolderAccess;
};

export type FolderRouteOptions = {
  provider: FolderRouteProvider;
  accessProvider: FolderAccessProvider;
  resolveDashboardUserId?: (
    request: FastifyRequest,
  ) => Promise<string | null> | string | null;
  projectIdentityService?: Pick<
    FolderProjectIdentityService,
    "create" | "mutateFromFolder" | "backfillLegacyFolder"
  >;
  authBearerToken?: string;
};

export class FolderRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "FolderRouteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type FolderParams = {
  folder_id: string;
};

type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

const SYSTEM_FOLDER_IDS = new Set(["claude", "llm"]);

export const folderRouteAuthRequirements = {
  "GET /api/folders": true,
  "POST /api/folders": true,
  "PUT /api/folders/:folder_id": true,
  "DELETE /api/folders/:folder_id": true,
  "PATCH /api/folders/reorder": true,
} as const;

export function registerFolderRoutes(
  app: FastifyInstance,
  options: FolderRouteOptions,
): void {
  if (options.projectIdentityService && options.authBearerToken) {
    registerFolderProjectIdentityHostRoute(app, {
      service: options.projectIdentityService,
      authBearerToken: options.authBearerToken,
    });
  }
  app.get("/api/folders", async (request, reply) => {
    const access = normalizeAccess(await options.accessProvider.resolveAccess(request));
    const folders = [...(await options.provider.listFolders())];
    const assignments = await options.provider.listSessionAssignments();

    return reply.send({
      folders: filterFolders(access, folders),
      sessions: filterSessionAssignments(access, folders, assignments),
      access: accessPayload(access),
    });
  });

  app.post("/api/folders", async (request, reply) => {
    const body = parseObjectBody(request.body);
    if (!body.ok) return badRequest(reply, body.message);

    const name = requiredString(body.value, "name");
    if (!name.ok) return badRequest(reply, name.message);
    const sortOrder = optionalInteger(body.value, "sortOrder", 0);
    if (!sortOrder.ok) return badRequest(reply, sortOrder.message);
    const parentFolderId = optionalStringOrNull(body.value, "parentFolderId");
    if (!parentFolderId.ok) return badRequest(reply, parentFolderId.message);
    const idempotencyKey = optionalStringOrNull(body.value, "idempotencyKey");
    if (!idempotencyKey.ok) return badRequest(reply, idempotencyKey.message);

    const access = normalizeAccess(await options.accessProvider.resolveAccess(request));
    const folders = [...(await options.provider.listFolders())];
    const parentId = parentFolderId.value ?? null;
    if (!isFolderAllowed(access, folders, parentId)) return folderAccessDenied(reply);

    try {
      const folder = options.projectIdentityService
        ? (await options.projectIdentityService.create({
            name: name.value,
            sortOrder: sortOrder.value,
            parentFolderId: parentId,
            actor: await dashboardActor(request, options),
            idempotencyKey: idempotencyKey.value ?? randomUUID(),
          })).folder
        : await options.provider.createFolder(name.value, sortOrder.value, {
            parentFolderId: parentId,
          });
      return reply.code(201).send(folder);
    } catch (error) {
      return sendProviderError(reply, error, 400);
    }
  });

  app.patch("/api/folders/reorder", async (request, reply) => {
    const items = parseReorderBody(request.body);
    if (!items.ok) return badRequest(reply, items.message);

    const access = normalizeAccess(await options.accessProvider.resolveAccess(request));
    const folders = [...(await options.provider.listFolders())];
    for (const item of items.value) {
      if (!isFolderAllowed(access, folders, item.id)) return folderAccessDenied(reply);
      const systemGuard = rejectSystemFolderMutation(item.id, "moved or reordered");
      if (systemGuard !== null) return badRequest(reply, systemGuard);
      if (
        hasOwn(item, "parentFolderId") &&
        !isFolderAllowed(access, folders, item.parentFolderId ?? null)
      ) {
        return folderAccessDenied(reply);
      }
    }

    try {
      await options.provider.reorderFolders(items.value);
      return reply.send({ success: true });
    } catch (error) {
      return sendProviderError(reply, error, 400);
    }
  });

  app.put<{ Params: FolderParams }>(
    "/api/folders/:folder_id",
    async (request, reply) => {
      const body = parseObjectBody(request.body);
      if (!body.ok) return badRequest(reply, body.message);

      const update = parseUpdateBody(body.value);
      if (!update.ok) return badRequest(reply, update.message);

      const folderId = folderParams(request).folder_id;
      const access = normalizeAccess(await options.accessProvider.resolveAccess(request));
      const folders = [...(await options.provider.listFolders())];
      if (!isFolderAllowed(access, folders, folderId)) return folderAccessDenied(reply);

      const systemGuard = systemUpdateGuard(folderId, update.value);
      if (systemGuard !== null) return badRequest(reply, systemGuard);
      if (
        hasOwn(update.value, "parentFolderId") &&
        !isFolderAllowed(access, folders, update.value.parentFolderId ?? null)
      ) {
        return folderAccessDenied(reply);
      }

      try {
        if (options.projectIdentityService && typeof update.value.name === "string") {
          await options.projectIdentityService.mutateFromFolder({
            folderId,
            update: update.value,
            actor: await dashboardActor(request, options),
            idempotencyKey: requestIdempotencyKey(request, body.value),
          });
        } else {
          await options.provider.updateFolder(folderId, update.value);
        }
        return reply.send({ success: true });
      } catch (error) {
        return sendProviderError(reply, error, 400);
      }
    },
  );

  app.delete<{ Params: FolderParams }>(
    "/api/folders/:folder_id",
    async (request, reply) => {
      const folderId = folderParams(request).folder_id;
      const access = normalizeAccess(await options.accessProvider.resolveAccess(request));
      const folders = [...(await options.provider.listFolders())];
      if (!isFolderAllowed(access, folders, folderId)) return folderAccessDenied(reply);

      const systemGuard = rejectSystemFolderMutation(folderId, "deleted");
      if (systemGuard !== null) return badRequest(reply, systemGuard);

      try {
        if (options.projectIdentityService) {
          await options.projectIdentityService.mutateFromFolder({
            folderId,
            archived: true,
            actor: await dashboardActor(request, options),
            idempotencyKey: requestIdempotencyKey(request, {}),
          });
        } else {
          await options.provider.deleteFolder(folderId);
        }
        return reply.send({ success: true });
      } catch (error) {
        return sendProviderError(reply, error, 400);
      }
    },
  );
}

async function dashboardActor(
  request: FastifyRequest,
  options: FolderRouteOptions,
): Promise<PageMutationActor> {
  const userId = await options.resolveDashboardUserId?.(request) ?? null;
  return userId
    ? { actorKind: "user", actorUserId: userId }
    : { actorKind: "system" };
}

function requestIdempotencyKey(
  request: FastifyRequest,
  body: Record<string, unknown>,
): string {
  const supplied = body.idempotencyKey;
  if (typeof supplied === "string" && supplied.trim()) return supplied.trim();
  const header = request.headers["idempotency-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return randomUUID();
}

function parseUpdateBody(body: Record<string, unknown>): Validation<FolderUpdateInput> {
  const update: FolderUpdateInput = {};
  if (hasOwn(body, "name")) {
    const name = optionalStringOrNull(body, "name");
    if (!name.ok) return name;
    update.name = name.value ?? null;
  }
  if (hasOwn(body, "sortOrder")) {
    const sortOrder = optionalIntegerOrNull(body, "sortOrder");
    if (!sortOrder.ok) return sortOrder;
    update.sortOrder = sortOrder.value ?? null;
  }
  if (hasOwn(body, "settings")) {
    const settings = optionalObjectOrNull(body, "settings");
    if (!settings.ok) return settings;
    update.settings = settings.value ?? null;
  }
  if (hasOwn(body, "parentFolderId")) {
    const parentFolderId = optionalStringOrNull(body, "parentFolderId");
    if (!parentFolderId.ok) return parentFolderId;
    update.parentFolderId = parentFolderId.value ?? null;
  }
  return { ok: true, value: update };
}

function parseReorderBody(body: unknown): Validation<FolderReorderInput[]> {
  if (!Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON array" };
  }
  const items: FolderReorderInput[] = [];
  for (const rawItem of body) {
    if (rawItem === null || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      return { ok: false, message: "Each reorder item must be a JSON object" };
    }
    const item = rawItem as Record<string, unknown>;
    const id = requiredString(item, "id");
    if (!id.ok) return id;
    const sortOrder = requiredInteger(item, "sortOrder");
    if (!sortOrder.ok) return sortOrder;
    const entry: FolderReorderInput = { id: id.value, sortOrder: sortOrder.value };
    if (hasOwn(item, "parentFolderId")) {
      const parentFolderId = optionalStringOrNull(item, "parentFolderId");
      if (!parentFolderId.ok) return parentFolderId;
      entry.parentFolderId = parentFolderId.value ?? null;
    }
    items.push(entry);
  }
  return { ok: true, value: items };
}

function systemUpdateGuard(
  folderId: string,
  update: FolderUpdateInput,
): string | null {
  if (update.name !== undefined && update.name !== null) {
    return rejectSystemFolderMutation(folderId, "renamed");
  }
  if (update.sortOrder !== undefined && update.sortOrder !== null) {
    return rejectSystemFolderMutation(folderId, "reordered");
  }
  if (hasOwn(update, "parentFolderId")) {
    return rejectSystemFolderMutation(folderId, "moved");
  }
  return null;
}

function rejectSystemFolderMutation(folderId: string, operation: string): string | null {
  if (!SYSTEM_FOLDER_IDS.has(folderId)) return null;
  return `System folder '${folderId}' cannot be ${operation}.`;
}

function parseObjectBody(body: unknown): Validation<Record<string, unknown>> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (typeof body === "object" && !Array.isArray(body)) {
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

function optionalStringOrNull(
  body: Record<string, unknown>,
  key: string,
): Validation<string | null | undefined> {
  if (!hasOwn(body, key)) return { ok: true, value: undefined };
  const value = body[key];
  if (value === null || typeof value === "string") return { ok: true, value };
  return { ok: false, message: `${key} must be a string or null` };
}

function requiredInteger(
  body: Record<string, unknown>,
  key: string,
): Validation<number> {
  const value = body[key];
  if (typeof value === "number" && Number.isInteger(value)) {
    return { ok: true, value };
  }
  return { ok: false, message: `${key} must be an integer` };
}

function optionalInteger(
  body: Record<string, unknown>,
  key: string,
  defaultValue: number,
): Validation<number> {
  if (!hasOwn(body, key)) return { ok: true, value: defaultValue };
  return requiredInteger(body, key);
}

function optionalIntegerOrNull(
  body: Record<string, unknown>,
  key: string,
): Validation<number | null | undefined> {
  if (!hasOwn(body, key)) return { ok: true, value: undefined };
  const value = body[key];
  if (value === null) return { ok: true, value: null };
  return requiredInteger(body, key);
}

function optionalObjectOrNull(
  body: Record<string, unknown>,
  key: string,
): Validation<Record<string, unknown> | null | undefined> {
  if (!hasOwn(body, key)) return { ok: true, value: undefined };
  const value = body[key];
  if (value === null) return { ok: true, value: null };
  if (typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, value: value as Record<string, unknown> };
  }
  return { ok: false, message: `${key} must be an object or null` };
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ detail: message });
}

function folderAccessDenied(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ detail: "Folder access denied" });
}

function sendProviderError(
  reply: FastifyReply,
  error: unknown,
  fallbackStatusCode: number,
): FastifyReply {
  if (error instanceof FolderRouteError) {
    return reply.code(error.statusCode).send({ detail: error.message });
  }
  const message = error instanceof Error ? error.message : "Folder route failed";
  return reply.code(fallbackStatusCode).send({ detail: message });
}

function folderParams(request: FastifyRequest): FolderParams {
  return request.params as FolderParams;
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

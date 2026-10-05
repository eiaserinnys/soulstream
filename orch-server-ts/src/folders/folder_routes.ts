import { registerCardRoutes, cardRouteAuthRequirements } from "../cards/card_routes.js";
import type { CardControlPlaneService } from "../cards/card_control_plane_service.js";
import { registerFolderWorkspaceRoutes, folderWorkspaceRouteAuthRequirements, dashboardFolderActor, folderOperationError } from "./folder_workspace_routes.js";
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
import type { FolderProjectIdentityService } from "./folder_project_identity_service.js";
import type { FolderControlPlaneService } from "./folder_control_plane_service.js";
import { registerFolderControlPlaneHostRoute } from "./folder_control_plane_host_route.js";

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
  listSessionAssignments: (includeSessions?: boolean) =>
    | Promise<Record<string, SessionAssignmentRecord>>
    | Record<string, SessionAssignmentRecord>;

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
    "create" | "mutateFromFolder"
  >;
  authBearerToken?: string;
  environment?: string;
  cardServiceProvider?: () => Promise<CardControlPlaneService>;
  cardExecutionServiceProvider?: () => Promise<import("../cards/card_execution_service.js").CardExecutionService>;
  controlPlaneServiceProvider?: () => Promise<FolderControlPlaneService>;
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
  ...folderWorkspaceRouteAuthRequirements,
  ...cardRouteAuthRequirements,
  "PATCH /api/folders/reorder": true,
} as const;

export function registerFolderRoutes(
  app: FastifyInstance,
  options: FolderRouteOptions,
): void {
  registerFolderWorkspaceRoutes(app, options);
  registerCardRoutes(app, options);
  if (options.controlPlaneServiceProvider) {
    registerFolderControlPlaneHostRoute(app, {
      serviceProvider: options.controlPlaneServiceProvider,
      cardServiceProvider: options.cardServiceProvider,
      identity: options.projectIdentityService,
      authBearerToken: options.authBearerToken ?? "",
      environment: options.environment,
    });
  }
  app.get("/api/folders", async (request, reply) => {
    const access = normalizeAccess(await options.accessProvider.resolveAccess(request));
    const folders = [...(await options.provider.listFolders())];
    const includeSessions = queryValue(request.query, "sessions") !== "false";
    const assignments = await options.provider.listSessionAssignments(includeSessions);

    return reply.send({
      folders: filterFolders(access, folders),
      sessions: includeSessions
        ? filterSessionAssignments(access, folders, assignments)
        : {},
      access: accessPayload(access),
    });
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
      if (!options.projectIdentityService || !options.cardServiceProvider) throw new Error("Folder services are not configured");
      const actor = await dashboardFolderActor(request, options);
      const cards = await options.cardServiceProvider();
      for (const item of items.value) {
        const snapshot = await cards.getFolder(item.id);
        if (!snapshot) return reply.code(404).send({ detail: { error: { code: "FOLDER_NOT_FOUND", message: item.id } } });
        const { id, ...update } = item;
        await options.projectIdentityService.mutateFromFolder({ folderId: id, update,
          expectedVersion: snapshot.folder.version, idempotencyKey: randomUUID(),
          actor: { actorKind: "user", actorUserId: actor.actorUserId! } });
      }
      return reply.send({ success: true });
    } catch (error) {
      return folderOperationError(reply, error);
    }
  });

}

function queryValue(query: unknown, key: string): unknown {
  if (typeof query !== "object" || query === null || !(key in query)) return undefined;
  const value = (query as Record<string, unknown>)[key];
  return Array.isArray(value) ? value[0] : value;
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

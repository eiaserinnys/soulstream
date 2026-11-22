import { registerCardRoutes, cardRouteAuthRequirements } from "../cards/card_routes.js";
import type { CardControlPlaneService } from "../cards/card_control_plane_service.js";
import { registerFolderWorkspaceRoutes, folderWorkspaceRouteAuthRequirements, dashboardFolderActor, folderOperationError } from "./folder_workspace_routes.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CatalogSessionAssignment } from "@soulstream/wire-schema/catalog";

import { isBoardFolderAllowed, normalizeBoardAccess, type BoardAccess } from "../board/board_access.js";
import {
  accessPayload,
  filterFolders,
  filterSessionAssignments,
  type FolderRecord,
} from "./folder_route_access.js";
import type { FolderProjectIdentityService } from "./folder_project_identity_service.js";
import type { FolderControlPlaneService } from "./folder_control_plane_service.js";
import { registerFolderControlPlaneHostRoute } from "./folder_control_plane_host_route.js";
import { folderProjectPageVersion, folderStarred, loadProjectPageStates, type ProjectPageState } from "./folder_starred.js";
import {
  badRequest,
  folderAccessDenied,
  hasOwn,
  optionalStringOrNull,
  queryValue,
  requiredInteger,
  requiredString,
  type Validation,
} from "../http/route_validation.js";

export type { FolderRecord } from "./folder_route_access.js";

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
    | Promise<Record<string, CatalogSessionAssignment>>
    | Record<string, CatalogSessionAssignment>;
  listProjectPageStates?: (
    pageIds: readonly string[],
  ) => Promise<readonly ProjectPageState[]> | readonly ProjectPageState[];
};

export type FolderAccessProvider = {
  resolveAccess: (request: FastifyRequest) => Promise<BoardAccess> | BoardAccess;
};

export type CardCommentAttachmentUploadInput = {
  cardId: string;
  folderId: string;
  nodeId: string | null;
  sessionId: string | null;
  file: { name: string; mime: string; data_base64: string };
  uploadId: string;
};

export type CardCommentAttachmentUploadResult = { url: string; name: string; mime: string };

export type CardCommentAttachmentUploader = (
  request: FastifyRequest,
  input: CardCommentAttachmentUploadInput,
) => Promise<CardCommentAttachmentUploadResult>;

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
  nodeCredentials: import("../node_credentials/types.js").NodeCredentialResolver | null;
  cardServiceProvider?: () => Promise<CardControlPlaneService>;
  cardExecutionServiceProvider?: () => Promise<import("../cards/card_execution_service.js").CardExecutionService>;
  sendCardSessionMessage?: (
    request: FastifyRequest,
    sessionId: string,
    body: {
      text: string;
      delivery_id?: string;
      attachments?: Array<{ name: string; mime: string; data_base64: string }>;
    },
  ) => Promise<{ status: number; body: unknown }>;
  uploadCardCommentAttachment?: CardCommentAttachmentUploader;
  controlPlaneServiceProvider?: () => Promise<FolderControlPlaneService>;
  /** 카드 목록·상세 HTTP 응답에 담당 에이전트 표시 정보를 붙인다. */
  assigneeAgentEnricher?: import("../cards/card_assignee_agent.js").CardAssigneeAgentEnricher;
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
      nodeCredentials: options.nodeCredentials,
    });
  }
  app.get("/api/folders", async (request, reply) => {
    const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
    const folders = [...(await options.provider.listFolders())];
    const includeSessions = queryValue(request.query, "sessions") !== "false";
    const visibleFolders = filterFolders(access, folders);
    const [assignments, pageStates] = await Promise.all([
      options.provider.listSessionAssignments(includeSessions),
      loadProjectPageStates(options.provider.listProjectPageStates, visibleFolders),
    ]);

    return reply.send({
      folders: visibleFolders.map((folder) => ({ ...folder,
        starred: folderStarred(folder, pageStates),
        projectPageVersion: folderProjectPageVersion(folder, pageStates) })),
      sessions: includeSessions
        ? filterSessionAssignments(access, folders, assignments)
        : {},
      access: accessPayload(access),
    });
  });

  app.patch("/api/folders/reorder", async (request, reply) => {
    const items = parseReorderBody(request.body);
    if (!items.ok) return badRequest(reply, items.message);

    const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
    const folders = [...(await options.provider.listFolders())];
    for (const item of items.value) {
      if (!isBoardFolderAllowed(access, folders, item.id)) return folderAccessDenied(reply);
      const systemGuard = rejectSystemFolderMutation(item.id, "moved or reordered");
      if (systemGuard !== null) return badRequest(reply, systemGuard);
      if (
        hasOwn(item, "parentFolderId") &&
        !isBoardFolderAllowed(access, folders, item.parentFolderId ?? null)
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

function rejectSystemFolderMutation(folderId: string, operation: string): string | null {
  if (!SYSTEM_FOLDER_IDS.has(folderId)) return null;
  return `System folder '${folderId}' cannot be ${operation}.`;
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  proxyBoardYjsHostRequest,
  type BoardYjsHostProxyRouteOptions,
} from "./board_yjs_host_proxy.js";

export type BoardItemFolderRecord = {
  id: string;
  parentFolderId?: string | null;
  [key: string]: unknown;
};

export type BoardItemRecord = {
  id: string;
  folderId?: string | null;
  [key: string]: unknown;
};

export type BoardItemAccess = {
  restricted: boolean;
  allowedFolderIds?: readonly string[];
};

export type BoardContainerKind = "folder" | "runbook";

export type BoardContainerTarget = {
  kind: BoardContainerKind;
  id: string;
};

export type BoardItemListQuery =
  | { folderId: string }
  | { container: BoardContainerTarget };

export type BoardItemCatalogSnapshot = {
  folders: readonly BoardItemFolderRecord[];
  boardItems: readonly BoardItemRecord[];
};

export type BoardItemRouteProvider = {
  listFolders: () =>
    | Promise<readonly BoardItemFolderRecord[]>
    | readonly BoardItemFolderRecord[];
  listBoardItems: (
    query: BoardItemListQuery,
  ) => Promise<readonly BoardItemRecord[]> | readonly BoardItemRecord[];
  resolveBoardContainerFolderId: (
    container: BoardContainerTarget,
  ) => Promise<string> | string;
  getCatalogSnapshot: () =>
    | Promise<BoardItemCatalogSnapshot>
    | BoardItemCatalogSnapshot;
};

export type BoardItemAccessProvider = {
  resolveAccess: (request: FastifyRequest) => Promise<BoardItemAccess> | BoardItemAccess;
};

export type BoardItemRouteOptions = {
  provider: BoardItemRouteProvider;
  accessProvider: BoardItemAccessProvider;
  hostProxy: BoardYjsHostProxyRouteOptions;
};

export class BoardItemRouteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "BoardItemRouteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type BoardItemParams = {
  board_item_id: string;
};

type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; statusCode?: number };

export const boardItemRouteAuthRequirements = {
  "GET /api/board-items": true,
  "PATCH /api/board-items/:board_item_id/position": true,
  "PATCH /api/board-items/:board_item_id/container": true,
} as const;

export function registerBoardItemRoutes(
  app: FastifyInstance,
  options: BoardItemRouteOptions,
): void {
  app.get("/api/board-items", async (request, reply) => {
    const query = parseListQuery(request.query);
    if (!query.ok) return badRequest(reply, query.message);

    const folders = [...(await options.provider.listFolders())];
    const inheritedFolderIdResult =
      "folderId" in query.value
        ? { ok: true as const, value: query.value.folderId }
        : await tryResolveBoardContainerFolderId(
            options.provider,
            query.value.container,
          );
    if (!inheritedFolderIdResult.ok) {
      return sendBoardItemRouteError(reply, inheritedFolderIdResult.error, 400);
    }
    const access = normalizeAccess(await options.accessProvider.resolveAccess(request));
    if (!isFolderAllowed(access, folders, inheritedFolderIdResult.value)) {
      return folderAccessDenied(reply);
    }
    const boardItems = await options.provider.listBoardItems(query.value);
    return reply.send({ boardItems });
  });

  app.patch<{ Params: BoardItemParams }>(
    "/api/board-items/:board_item_id/position",
    async (request, reply) => {
      const body = parsePositionBody(request.body);
      if (!body.ok) return validationError(reply, body);

      const boardItemId = boardItemParams(request).board_item_id;
      const access = normalizeAccess(await options.accessProvider.resolveAccess(request));
      if (access.restricted) {
        const snapshot = await options.provider.getCatalogSnapshot();
        const boardItem = findBoardItem(snapshot.boardItems, boardItemId);
        if (boardItem === undefined) return boardItemNotFound(reply);
        if (!isFolderAllowed(access, snapshot.folders, stringOrNull(boardItem.folderId))) {
          return folderAccessDenied(reply);
        }
      }

      return proxyBoardYjsHostRequest(request, reply, options.hostProxy, {
        method: "PATCH",
        upstreamPath: `/api/board-items/${encodeURIComponent(boardItemId)}/position`,
        body: body.value,
      });
    },
  );

  app.patch<{ Params: BoardItemParams }>(
    "/api/board-items/:board_item_id/container",
    async (request, reply) => {
      const body = parseContainerMoveBody(request.body);
      if (!body.ok) return validationError(reply, body);

      const boardItemId = boardItemParams(request).board_item_id;
      const access = normalizeAccess(await options.accessProvider.resolveAccess(request));
      const snapshot = await options.provider.getCatalogSnapshot();
      const boardItem = findBoardItem(snapshot.boardItems, boardItemId);
      if (boardItem === undefined) return boardItemNotFound(reply);
      if (!isFolderAllowed(access, snapshot.folders, stringOrNull(boardItem.folderId))) {
        return folderAccessDenied(reply);
      }

      const targetFolderId = await tryResolveBoardContainerFolderId(
        options.provider,
        body.value.container,
      );
      if (!targetFolderId.ok) {
        return sendBoardItemRouteError(reply, targetFolderId.error, 400);
      }
      if (!isFolderAllowed(access, snapshot.folders, targetFolderId.value)) {
        return folderAccessDenied(reply);
      }

      return proxyBoardYjsHostRequest(request, reply, options.hostProxy, {
        method: "PATCH",
        upstreamPath: `/api/board-items/${encodeURIComponent(boardItemId)}/container`,
        body: body.value,
      });
    },
  );
}

function parseListQuery(query: unknown): Validation<BoardItemListQuery> {
  const values =
    query !== null && typeof query === "object"
      ? (query as Record<string, unknown>)
      : {};
  const folderId = optionalQueryString(values, "folder_id");
  const containerKind = optionalQueryString(values, "container_kind");
  const containerId = optionalQueryString(values, "container_id");

  if (folderId !== undefined && (containerKind !== undefined || containerId !== undefined)) {
    return {
      ok: false,
      message: "folder_id and container_kind/container_id are mutually exclusive",
    };
  }
  if (folderId !== undefined) return { ok: true, value: { folderId } };
  if (containerKind === undefined || containerId === undefined) {
    return {
      ok: false,
      message: "folder_id or container_kind/container_id is required",
    };
  }
  const kind = parseContainerKind(containerKind);
  if (!kind.ok) return kind;
  return { ok: true, value: { container: { kind: kind.value, id: containerId } } };
}

function parsePositionBody(body: unknown): Validation<{ x: number; y: number }> {
  const object = parseObjectBody(body);
  if (!object.ok) return object;
  const x = requiredFiniteNumber(object.value, "x");
  if (!x.ok) return x;
  const y = requiredFiniteNumber(object.value, "y");
  if (!y.ok) return y;
  return { ok: true, value: { x: x.value, y: y.value } };
}

function parseContainerMoveBody(
  body: unknown,
): Validation<{
  container: BoardContainerTarget;
  idempotencyKey: string;
  x?: number;
  y?: number;
}> {
  const object = parseObjectBody(body);
  if (!object.ok) return object;

  const container = parseContainerBody(object.value.container);
  if (!container.ok) return container;

  const idempotencyKey = idempotencyKeyValue(object.value);
  if (!idempotencyKey.ok) return idempotencyKey;

  const hasX = object.value.x !== undefined && object.value.x !== null;
  const hasY = object.value.y !== undefined && object.value.y !== null;
  if (hasX !== hasY) {
    return {
      ok: false,
      message: "x and y must be supplied together",
      statusCode: 422,
    };
  }

  const value: {
    container: BoardContainerTarget;
    idempotencyKey: string;
    x?: number;
    y?: number;
  } = {
    container: container.value,
    idempotencyKey: idempotencyKey.value,
  };
  if (hasX && hasY) {
    const x = requiredFiniteNumber(object.value, "x");
    if (!x.ok) return x;
    const y = requiredFiniteNumber(object.value, "y");
    if (!y.ok) return y;
    value.x = x.value;
    value.y = y.value;
  }

  return { ok: true, value };
}

function parseContainerBody(value: unknown): Validation<BoardContainerTarget> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "container must be a JSON object" };
  }
  const container = value as Record<string, unknown>;
  const kindRaw = requiredString(container, "kind");
  if (!kindRaw.ok) return kindRaw;
  const kind = parseContainerKind(kindRaw.value);
  if (!kind.ok) return kind;
  const id = requiredString(container, "id");
  if (!id.ok) return id;
  if (id.value.length === 0) return { ok: false, message: "id must not be empty" };
  return { ok: true, value: { kind: kind.value, id: id.value } };
}

function idempotencyKeyValue(
  body: Record<string, unknown>,
): Validation<string> {
  const raw = hasOwn(body, "idempotencyKey")
    ? body.idempotencyKey
    : body.idempotency_key;
  if (typeof raw === "string") return { ok: true, value: raw };
  return { ok: false, message: "idempotencyKey must be a string" };
}

async function resolveBoardContainerFolderId(
  provider: BoardItemRouteProvider,
  container: BoardContainerTarget,
): Promise<string> {
  if (container.kind === "folder") return container.id;
  try {
    return await provider.resolveBoardContainerFolderId(container);
  } catch (error) {
    if (error instanceof BoardItemRouteError) throw error;
    throw new BoardItemRouteError(
      "BOARD_CONTAINER_NOT_FOUND",
      error instanceof Error ? error.message : String(error),
      404,
    );
  }
}

async function tryResolveBoardContainerFolderId(
  provider: BoardItemRouteProvider,
  container: BoardContainerTarget,
): Promise<{ ok: true; value: string } | { ok: false; error: unknown }> {
  try {
    return {
      ok: true,
      value: await resolveBoardContainerFolderId(provider, container),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

function normalizeAccess(access: BoardItemAccess): Required<BoardItemAccess> {
  return {
    restricted: access.restricted,
    allowedFolderIds: [...(access.allowedFolderIds ?? [])],
  };
}

function isFolderAllowed(
  access: Required<BoardItemAccess>,
  folders: readonly BoardItemFolderRecord[],
  folderId: string | null,
): boolean {
  if (!access.restricted) return true;
  if (folderId === null) return false;
  return visibleFolderIds(access, folders).has(folderId);
}

function visibleFolderIds(
  access: Required<BoardItemAccess>,
  folders: readonly BoardItemFolderRecord[],
): Set<string> {
  const knownIds = new Set<string>();
  const byParent = new Map<string | null, string[]>();
  for (const folder of folders) {
    knownIds.add(folder.id);
    const parentId =
      typeof folder.parentFolderId === "string" ? folder.parentFolderId : null;
    const children = byParent.get(parentId) ?? [];
    children.push(folder.id);
    byParent.set(parentId, children);
  }

  const visible = new Set<string>();
  const stack = access.allowedFolderIds.filter((folderId) => knownIds.has(folderId));
  while (stack.length > 0) {
    const folderId = stack.pop();
    if (folderId === undefined || visible.has(folderId)) continue;
    visible.add(folderId);
    stack.push(...(byParent.get(folderId) ?? []));
  }
  return visible;
}

function findBoardItem(
  boardItems: readonly BoardItemRecord[],
  boardItemId: string,
): BoardItemRecord | undefined {
  return boardItems.find((item) => item.id === boardItemId);
}

function parseObjectBody(body: unknown): Validation<Record<string, unknown>> {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    return { ok: true, value: body as Record<string, unknown> };
  }
  return { ok: false, message: "Request body must be a JSON object" };
}

function optionalQueryString(
  query: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = query[key];
  return typeof value === "string" ? value : undefined;
}

function parseContainerKind(value: string): Validation<BoardContainerKind> {
  if (value === "folder" || value === "runbook") {
    return { ok: true, value };
  }
  return { ok: false, message: "container_kind must be folder or runbook" };
}

function requiredString(
  body: Record<string, unknown>,
  key: string,
): Validation<string> {
  const value = body[key];
  if (typeof value === "string") return { ok: true, value };
  return { ok: false, message: `${key} must be a string` };
}

function requiredFiniteNumber(
  body: Record<string, unknown>,
  key: string,
): Validation<number> {
  const value = body[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ok: true, value };
  }
  return { ok: false, message: `${key} must be a number` };
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ detail: message });
}

function validationError<T>(
  reply: FastifyReply,
  validation: Extract<Validation<T>, { ok: false }>,
): FastifyReply {
  return reply.code(validation.statusCode ?? 400).send({ detail: validation.message });
}

function folderAccessDenied(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ detail: "Folder access denied" });
}

function boardItemNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ detail: "Board item not found" });
}

function sendBoardItemRouteError(
  reply: FastifyReply,
  error: unknown,
  fallbackStatusCode: number,
): FastifyReply {
  if (error instanceof BoardItemRouteError) {
    return reply.code(error.statusCode).send({ detail: error.message });
  }
  const message = error instanceof Error ? error.message : "Board item route failed";
  return reply.code(fallbackStatusCode).send({ detail: message });
}

function boardItemParams(request: FastifyRequest): BoardItemParams {
  return request.params as BoardItemParams;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

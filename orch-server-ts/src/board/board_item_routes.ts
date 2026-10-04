import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";
import {
  sendBoardYjsHostProxyError,
  type BoardYjsHostProxyRouteOptions,
} from "./board_yjs_host_proxy.js";
import {
  moveLocalBoardItem,
  updateLocalBoardItemPosition,
} from "./board_item_local_mutations.js";

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

export type BoardItemListQuery = { folderId: string } | { sessionId: string };

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
  getBoardItemById: (
    boardItemId: string,
  ) => Promise<BoardItemRecord | null> | BoardItemRecord | null;
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
  "PATCH /api/board-items/:board_item_id/folder": true,
} as const;

export function registerBoardItemRoutes(
  app: FastifyInstance,
  options: BoardItemRouteOptions,
): void {
  app.get("/api/board-items", async (request, reply) => {
    const query = parseListQuery(request.query);
    if (!query.ok) return badRequest(reply, query.message);

    const folders = [...(await options.provider.listFolders())];
    if ("sessionId" in query.value) {
      const boardItems = await options.provider.listBoardItems(query.value);
      const access = normalizeAccess(await options.accessProvider.resolveAccess(request));
      if (boardItems.some((item) => (
        !isFolderAllowed(access, folders, stringOrNull(item.folderId))
      ))) {
        return folderAccessDenied(reply);
      }
      return reply.send({ boardItems });
    }
    const access = normalizeAccess(await options.accessProvider.resolveAccess(request));
    if (!isFolderAllowed(access, folders, query.value.folderId)) return folderAccessDenied(reply);
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
      let folders: readonly BoardItemFolderRecord[] = [];
      if (access.restricted) {
        folders = await options.provider.listFolders();
        const boardItem = await options.provider.getBoardItemById(boardItemId);
        if (boardItem === null) return boardItemNotFound(reply);
        if (!isFolderAllowed(access, folders, stringOrNull(boardItem.folderId))) {
          return folderAccessDenied(reply);
        }
      }

      try {
        const boardItem = await options.provider.getBoardItemById(boardItemId);
        if (boardItem === null) return boardItemNotFound(reply);
        await updateLocalBoardItemPosition(
          app, options.hostProxy, boardItem, boardItemId, body.value.x, body.value.y,
        );
        return reply.send({ ok: true });
      } catch (error) {
        return sendBoardYjsHostProxyError(reply, error);
      }
    },
  );

  app.patch<{ Params: BoardItemParams }>(
    "/api/board-items/:board_item_id/folder",
    async (request, reply) => {
      const body = parseFolderMoveBody(request.body);
      if (!body.ok) return validationError(reply, body);

      const boardItemId = boardItemParams(request).board_item_id;
      const access = normalizeAccess(await options.accessProvider.resolveAccess(request));
      const folders = access.restricted ? await options.provider.listFolders() : [];
      const boardItem = await options.provider.getBoardItemById(boardItemId);
      if (boardItem === null) return boardItemNotFound(reply);
      if (!isFolderAllowed(access, folders, stringOrNull(boardItem.folderId))) {
        return folderAccessDenied(reply);
      }

      if (!isFolderAllowed(access, folders, body.value.folderId)) return folderAccessDenied(reply);
      try {
        const position = body.value.x !== undefined && body.value.y !== undefined
          ? { x: body.value.x, y: body.value.y }
          : undefined;
        const moved = await moveLocalBoardItem(
          app,
          options.hostProxy,
          boardItem,
          body.value.folderId,
          position,
          body.value.idempotencyKey,
        );
        return reply.send({ ok: true, boardItem: moved });
      } catch (error) {
        return sendBoardYjsHostProxyError(reply, error);
      }
    },
  );
}

function parseListQuery(query: unknown): Validation<BoardItemListQuery> {
  const parsed = z.union([
    z.object({ folderId: z.string().min(1) }).strict(),
    z.object({ sessionId: z.string().min(1) }).strict(),
  ]).safeParse(query);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: parsed.error.message, statusCode: 422 };
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

function parseFolderMoveBody(body: unknown): Validation<{ folderId: string; idempotencyKey: string; x?: number; y?: number }> {
  const parsed = z.object({ folderId: z.string().min(1), idempotencyKey: z.string().min(1),
    x: z.number().finite().optional(), y: z.number().finite().optional(),
  }).strict().refine(value => (value.x === undefined) === (value.y === undefined), "x and y must be supplied together").safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: parsed.error.message, statusCode: 422 };
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

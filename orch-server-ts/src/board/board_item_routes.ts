import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { z } from "zod";
import {
  isBoardFolderAllowed,
  normalizeBoardAccess,
  type BoardAccess,
  type BoardAccessFolderRecord,
} from "./board_access.js";
import type { FlatFolderContentHost } from "./flat_folder_content_host.js";
import {
  badRequest,
  folderAccessDenied,
  validationError,
  type Validation,
} from "../http/route_validation.js";

export type BoardItemRecord = {
  id: string;
  folderId?: string | null;
  [key: string]: unknown;
};

export type BoardItemListQuery = { folderId: string } | { sessionId: string };

export type BoardItemCatalogSnapshot = {
  folders: readonly BoardAccessFolderRecord[];
  boardItems: readonly BoardItemRecord[];
};

export type BoardItemRouteProvider = {
  listFolders: () =>
    | Promise<readonly BoardAccessFolderRecord[]>
    | readonly BoardAccessFolderRecord[];
  listBoardItems: (
    query: BoardItemListQuery,
  ) => Promise<readonly BoardItemRecord[]> | readonly BoardItemRecord[];
  getBoardItemById: (
    boardItemId: string,
  ) => Promise<BoardItemRecord | null> | BoardItemRecord | null;
  getPrimarySessionBoardItem: (
    sessionId: string,
  ) => Promise<BoardItemRecord | null> | BoardItemRecord | null;
  getCatalogSnapshot: () =>
    | Promise<BoardItemCatalogSnapshot>
    | BoardItemCatalogSnapshot;
};

export type BoardItemAccessProvider = {
  resolveAccess: (request: FastifyRequest) => Promise<BoardAccess> | BoardAccess;
};

export type BoardItemRouteOptions = {
  provider: BoardItemRouteProvider;
  accessProvider: BoardItemAccessProvider;
  host: FlatFolderContentHost;
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

export const boardItemRouteAuthRequirements = {
  "GET /api/board-items": true,
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
      const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
      if (boardItems.some((item) => (
        !isBoardFolderAllowed(access, folders, stringOrNull(item.folderId))
      ))) {
        return folderAccessDenied(reply);
      }
      return reply.send({ boardItems });
    }
    const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
    if (!isBoardFolderAllowed(access, folders, query.value.folderId)) return folderAccessDenied(reply);
    const boardItems = await options.provider.listBoardItems(query.value);
    return reply.send({ boardItems });
  });

  app.patch<{ Params: BoardItemParams }>(
    "/api/board-items/:board_item_id/folder",
    async (request, reply) => {
      const body = parseFolderMoveBody(request.body);
      if (!body.ok) return validationError(reply, body);

      const boardItemId = boardItemParams(request).board_item_id;
      const access = normalizeBoardAccess(await options.accessProvider.resolveAccess(request));
      const folders = access.restricted ? await options.provider.listFolders() : [];
      const boardItem = await options.provider.getBoardItemById(boardItemId);
      if (boardItem === null) return boardItemNotFound(reply);
      if (!isBoardFolderAllowed(access, folders, stringOrNull(boardItem.folderId))) {
        return folderAccessDenied(reply);
      }

      if (!isBoardFolderAllowed(access, folders, body.value.folderId)) return folderAccessDenied(reply);
      try {
        const moved = await options.host.moveBoardItem(boardItemId, body.value.folderId, body.value.idempotencyKey);
        return reply.send({ ok: true, boardItem: moved });
      } catch (error) {
        const status = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
        return reply.code(status).send({ detail: error instanceof Error ? error.message : "Move failed" });
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

function parseFolderMoveBody(body: unknown): Validation<{ folderId: string; idempotencyKey: string; x?: number; y?: number }> {
  const parsed = z.object({ folderId: z.string().min(1), idempotencyKey: z.string().min(1),
    x: z.number().finite().optional(), y: z.number().finite().optional(),
  }).strict().refine(value => (value.x === undefined) === (value.y === undefined), "x and y must be supplied together").safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: parsed.error.message, statusCode: 422 };
}

function boardItemNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ detail: "Board item not found" });
}

function boardItemParams(request: FastifyRequest): BoardItemParams {
  return request.params as BoardItemParams;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

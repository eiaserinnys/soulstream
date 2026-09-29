import type { FastifyInstance } from "fastify";

import {
  authenticateDashboardHttpRequest,
  type BoardYjsAuthConfig,
} from "../collaboration/board_yjs_auth.js";
import type { CatalogService } from "./catalog_service.js";

export interface BoardItemHttpRouteConfig {
  service: CatalogService;
  auth: BoardYjsAuthConfig;
}

interface BoardItemRouteParams {
  boardItemId: string;
}

interface BoardItemFolderMoveBody {
  folderId?: unknown;
  x?: unknown;
  y?: unknown;
  idempotencyKey?: unknown;
}

interface BoardItemPositionBody {
  x?: unknown;
  y?: unknown;
}

export function registerBoardItemHttpRoutes(
  fastify: FastifyInstance,
  config: BoardItemHttpRouteConfig,
): void {
  fastify.patch<{
    Params: BoardItemRouteParams;
    Body: BoardItemPositionBody;
  }>("/api/board-items/:boardItemId/position", async (request, reply) => {
    try {
      await authenticateDashboardHttpRequest({
        requestHeaders: request.headers,
        config: config.auth,
      });
    } catch (err) {
      return reply.status(401).send({
        detail: {
          error: {
            code: "UNAUTHORIZED",
            message: err instanceof Error ? err.message : "Authentication failed",
          },
        },
      });
    }

    const parsed = parsePositionBody(request.body ?? {});
    if (!parsed.ok) {
      return reply.status(422).send({
        detail: {
          error: {
            code: "INVALID_BOARD_ITEM_POSITION",
            message: parsed.error,
          },
        },
      });
    }

    try {
      await config.service.updateBoardItemPosition(
        request.params.boardItemId,
        parsed.value.x,
        parsed.value.y,
      );
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error({ err }, "Board item position update failed");
      return reply.status(500).send({
        detail: {
          error: {
            code: "BOARD_ITEM_POSITION_FAILED",
            message,
          },
        },
      });
    }
  });

  fastify.patch<{
    Params: BoardItemRouteParams;
    Body: BoardItemFolderMoveBody;
  }>("/api/board-items/:boardItemId/folder", async (request, reply) => {
    try {
      await authenticateDashboardHttpRequest({
        requestHeaders: request.headers,
        config: config.auth,
      });
    } catch (err) {
      return reply.status(401).send({
        detail: {
          error: {
            code: "UNAUTHORIZED",
            message: err instanceof Error ? err.message : "Authentication failed",
          },
        },
      });
    }

    const parsed = parseMoveBody(request.body ?? {});
    if (!parsed.ok) {
      return reply.status(422).send({
        detail: {
          error: {
            code: "INVALID_BOARD_ITEM_FOLDER_MOVE",
            message: parsed.error,
          },
        },
      });
    }

    try {
      const result = await config.service.moveBoardItemToFolder({
        boardItemId: request.params.boardItemId,
        folderId: parsed.value.folderId,
        ...(parsed.value.position ? { position: parsed.value.position } : {}),
        idempotencyKey: parsed.value.idempotencyKey,
      });
      return {
        ok: true,
        boardItem: result.boardItem,
        ...(result.enrolled ? { enrolled: true } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        return reply.status(404).send({
          detail: { error: { code: "BOARD_ITEM_MOVE_TARGET_NOT_FOUND", message } },
        });
      }
      if (
        message.includes("not movable") ||
        message.includes("membership") ||
        message.includes("required")
      ) {
        return reply.status(422).send({
          detail: { error: { code: "BOARD_ITEM_MOVE_REJECTED", message } },
        });
      }
      request.log.error({ err }, "Board item folder move failed");
      return reply.status(500).send({
        detail: {
          error: {
            code: "BOARD_ITEM_MOVE_FAILED",
            message,
          },
        },
      });
    }
  });
}

function parsePositionBody(
  body: BoardItemPositionBody,
): { ok: true; value: { x: number; y: number } } | { ok: false; error: string } {
  if (typeof body.x !== "number" || typeof body.y !== "number") {
    return { ok: false, error: "x and y are required" };
  }
  if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) {
    return { ok: false, error: "x and y must be finite numbers" };
  }
  return { ok: true, value: { x: body.x, y: body.y } };
}

function parseMoveBody(
  body: BoardItemFolderMoveBody,
): { ok: true; value: {
  folderId: string;
  position?: { x: number; y: number };
  idempotencyKey: string;
} } | { ok: false; error: string } {
  if (typeof body.folderId !== "string" || !body.folderId.trim()) {
    return { ok: false, error: "folderId is required" };
  }
  const idempotencyKey = body.idempotencyKey;
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    return { ok: false, error: "idempotencyKey is required" };
  }
  if (body.x === undefined && body.y === undefined) {
    return {
      ok: true,
      value: {
        folderId: body.folderId,
        idempotencyKey,
      },
    };
  }
  if (typeof body.x !== "number" || typeof body.y !== "number") {
    return { ok: false, error: "x and y must be supplied together" };
  }
  if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) {
    return { ok: false, error: "x and y must be finite numbers" };
  }
  return {
    ok: true,
    value: {
      folderId: body.folderId,
      position: { x: body.x, y: body.y },
      idempotencyKey,
    },
  };
}

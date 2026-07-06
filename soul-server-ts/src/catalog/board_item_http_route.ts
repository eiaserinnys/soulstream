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

interface BoardItemContainerRouteParams {
  boardItemId: string;
}

interface BoardItemContainerMoveBody {
  container?: unknown;
  x?: unknown;
  y?: unknown;
  idempotencyKey?: unknown;
  idempotency_key?: unknown;
}

export function registerBoardItemHttpRoutes(
  fastify: FastifyInstance,
  config: BoardItemHttpRouteConfig,
): void {
  fastify.patch<{
    Params: BoardItemContainerRouteParams;
    Body: BoardItemContainerMoveBody;
  }>("/api/board-items/:boardItemId/container", async (request, reply) => {
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
            code: "INVALID_BOARD_ITEM_CONTAINER_MOVE",
            message: parsed.error,
          },
        },
      });
    }

    try {
      const boardItem = await config.service.moveBoardItemToContainer({
        boardItemId: request.params.boardItemId,
        target: {
          containerKind: parsed.value.container.kind,
          containerId: parsed.value.container.id,
        },
        ...(parsed.value.position ? { position: parsed.value.position } : {}),
        idempotencyKey: parsed.value.idempotencyKey,
      });
      return { ok: true, boardItem };
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
      request.log.error({ err }, "Board item container move failed");
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

function parseMoveBody(
  body: BoardItemContainerMoveBody,
): { ok: true; value: {
  container: { kind: "folder" | "runbook"; id: string };
  position?: { x: number; y: number };
  idempotencyKey: string;
} } | { ok: false; error: string } {
  const container = body.container;
  if (!container || typeof container !== "object") {
    return { ok: false, error: "container is required" };
  }
  const kind = (container as { kind?: unknown }).kind;
  const id = (container as { id?: unknown }).id;
  if ((kind !== "folder" && kind !== "runbook") || typeof id !== "string" || !id.trim()) {
    return { ok: false, error: "invalid container" };
  }
  const idempotencyKey = body.idempotencyKey ?? body.idempotency_key;
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    return { ok: false, error: "idempotencyKey is required" };
  }
  if (body.x === undefined && body.y === undefined) {
    return {
      ok: true,
      value: {
        container: { kind, id },
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
      container: { kind, id },
      position: { x: body.x, y: body.y },
      idempotencyKey,
    },
  };
}

import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";

import type { BoardContainerKind } from "../db/session_db.js";
import type { BoardYjsService } from "./board_yjs_service.js";

export interface BoardYjsRouteConfig {
  service: BoardYjsService;
}

export async function registerBoardYjsRoutes(
  fastify: FastifyInstance,
  config: BoardYjsRouteConfig,
): Promise<void> {
  await fastify.register(websocket);
  fastify.get<{ Params: { folderId: string } }>(
    "/yjs/:folderId",
    { websocket: true },
    (socket, request) => {
      const folderId = request.params.folderId;
      config.service.handleConnection(socket, request.raw, folderId);
    },
  );
  fastify.get<{ Params: { containerKind: string; containerId: string } }>(
    "/yjs/:containerKind/:containerId",
    { websocket: true },
    (socket, request) => {
      const { containerKind, containerId } = request.params;
      if (!isBoardContainerKind(containerKind)) {
        socket.close(1008, "unsupported board container kind");
        return;
      }
      config.service.handleContainerConnection(socket, request.raw, {
        containerKind,
        containerId,
      });
    },
  );

  fastify.addHook("onClose", async () => {
    await config.service.close();
  });
}

function isBoardContainerKind(value: string): value is BoardContainerKind {
  return value === "folder" || value === "runbook";
}

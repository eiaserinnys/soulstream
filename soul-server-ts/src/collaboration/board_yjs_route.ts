import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";

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

  fastify.addHook("onClose", async () => {
    await config.service.close();
  });
}

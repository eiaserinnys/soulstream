import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import type { BoardYjsService } from "./board_yjs_service.js";
import { registerWebsocketPlugin } from "../websocket_plugin.js";

export const boardYjsRouteAuthRequirements = {
  "WEBSOCKET /yjs/{folderId}": false,
} as const;

export interface BoardYjsRouteOptions {
  createService: (logger: FastifyBaseLogger) => BoardYjsService;
}

export function registerBoardYjsRoutes(
  app: FastifyInstance,
  options: BoardYjsRouteOptions,
): void {
  const service = options.createService(app.log);
  registerWebsocketPlugin(app);
  app.after(() => {
    app.get<{ Params: { folderId: string } }>(
      "/yjs/:folderId",
      { websocket: true },
      (socket, request) => {
        service.handleConnection(socket, request.raw, request.params.folderId);
      },
    );
  });
  app.addHook("onClose", async () => service.close());
}

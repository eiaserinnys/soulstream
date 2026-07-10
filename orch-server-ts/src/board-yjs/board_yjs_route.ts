import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import type { BoardYjsService } from "./board_yjs_service.js";
import type { BoardContainerKind } from "./board_yjs_types.js";
import { registerWebsocketPlugin } from "../websocket_plugin.js";

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
    app.get<{ Params: { containerKind: string; containerId: string } }>(
      "/yjs/:containerKind/:containerId",
      { websocket: true },
      (socket, request) => {
        const { containerKind, containerId } = request.params;
        if (!isBoardContainerKind(containerKind)) {
          socket.close(1008, "unsupported board container kind");
          return;
        }
        service.handleContainerConnection(socket, request.raw, {
          containerKind,
          containerId,
        });
      },
    );
  });
  app.addHook("onClose", async () => service.close());
}

function isBoardContainerKind(value: string): value is BoardContainerKind {
  return value === "folder" || value === "runbook";
}

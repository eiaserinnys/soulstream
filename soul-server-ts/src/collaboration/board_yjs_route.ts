import websocket from "@fastify/websocket";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { Hocuspocus } from "@hocuspocus/server";
import type { Extension, onAuthenticatePayload } from "@hocuspocus/server";

import type { SessionDB } from "../db/session_db.js";
import {
  authenticateBoardYjsConnection,
  type BoardYjsAuthConfig,
} from "./board_yjs_auth.js";
import { getBoardYjsDocumentName } from "./board_yjs_model.js";
import { createBoardYjsPersistence } from "./board_yjs_persistence.js";

export interface BoardYjsRouteConfig {
  db: SessionDB;
  auth: BoardYjsAuthConfig;
  logger: FastifyBaseLogger;
}

export async function registerBoardYjsRoutes(
  fastify: FastifyInstance,
  config: BoardYjsRouteConfig,
): Promise<void> {
  const persistence = createBoardYjsPersistence(config.db);
  const hocuspocus = new Hocuspocus({
    name: "soulstream-board-yjs",
    quiet: true,
    debounce: 500,
    maxDebounce: 5_000,
    extensions: [
      createBoardYjsAuthExtension(config.auth, config.logger),
      persistence.updateLog,
      persistence.database,
    ],
  });

  await fastify.register(websocket);
  fastify.get<{ Params: { folderId: string } }>(
    "/yjs/:folderId",
    { websocket: true },
    (socket, request) => {
      const folderId = request.params.folderId;
      hocuspocus.handleConnection(socket, request.raw, {
        folderId,
        documentName: getBoardYjsDocumentName(folderId),
      });
    },
  );

  fastify.addHook("onClose", async () => {
    await hocuspocus.hooks("onDestroy", { instance: hocuspocus });
    hocuspocus.closeConnections();
  });
}

function createBoardYjsAuthExtension(
  auth: BoardYjsAuthConfig,
  logger: FastifyBaseLogger,
): Extension {
  return {
    extensionName: "soulstream-board-yjs-auth",
    async onAuthenticate(payload: onAuthenticatePayload) {
      const result = await authenticateBoardYjsConnection({
        token: payload.token,
        requestHeaders: payload.requestHeaders,
        config: auth,
      });
      logger.debug(
        {
          documentName: payload.documentName,
          authSource: result.source,
          subject: result.subject,
        },
        "board Yjs websocket authenticated",
      );
      return {
        user: result.subject,
      };
    },
  };
}

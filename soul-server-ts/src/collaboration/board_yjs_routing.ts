import type { FastifyBaseLogger } from "fastify";
import type { Logger } from "pino";

import { isBoardYjsHostNode } from "../board_yjs_host_mode.js";
import type { SessionDB } from "../db/session_db.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";
import type { BoardYjsAuthConfig } from "./board_yjs_auth.js";
import { BoardYjsHostClient } from "./board_yjs_host_client.js";
import { BoardYjsService } from "./board_yjs_service.js";

export interface BoardYjsRoutingConfig {
  db: SessionDB;
  auth: BoardYjsAuthConfig;
  logger: Logger & FastifyBaseLogger;
  orch: OrchProxyConfig;
  nodeId: string;
  hostNodeId: string;
}

export function createBoardYjsRouting(config: BoardYjsRoutingConfig) {
  const isBoardYjsHost = isBoardYjsHostNode(config.nodeId, config.hostNodeId);
  const localService = new BoardYjsService({
    db: config.db,
    logger: config.logger,
    auth: config.auth,
    nodeId: config.nodeId,
    hostNodeId: config.hostNodeId,
    isHost: isBoardYjsHost,
  });
  const mutationPort = isBoardYjsHost
    ? localService
    : new BoardYjsHostClient({ orch: config.orch, logger: config.logger });

  return { isBoardYjsHost, localService, mutationPort };
}

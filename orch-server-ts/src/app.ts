import Fastify, { type FastifyInstance } from "fastify";

import {
  registerBoardYjsHostProxyRoutes,
  type BoardYjsHostProxyRouteOptions,
} from "./board/board_yjs_host_proxy.js";
import type { OrchServerTsConfig } from "./config.js";
import { routeOwnerManifest, type RouteOwnerManifest } from "./contract/route_owner_manifest.js";
import {
  registerNodeSnapshotRoutes,
  type NodeSnapshotRouteOptions,
} from "./node/node_snapshot_routes.js";
import { registerNodeWsRoute, type NodeWsRouteOptions } from "./node/ws_route.js";
import {
  registerSessionCommandRoutes,
  type SessionCommandRouteOptions,
} from "./session/session_command_routes.js";
import {
  registerSessionHistoryRoutes,
  type SessionHistoryRouteOptions,
} from "./session/session_history_routes.js";
import {
  registerSessionSnapshotRoutes,
  type SessionSnapshotRouteOptions,
} from "./session/session_snapshot_routes.js";
import {
  registerSseReplayRoutes,
  type SseReplayRouteOptions,
} from "./sse/sse_replay_routes.js";

export type CreateAppOptions = {
  config: OrchServerTsConfig;
  routeOwners?: RouteOwnerManifest;
  exposeLocalHealthRoute?: boolean;
  nodeWsRoute?: NodeWsRouteOptions;
  nodeSnapshotRoutes?: NodeSnapshotRouteOptions;
  sessionCommandRoutes?: SessionCommandRouteOptions;
  sessionHistoryRoutes?: SessionHistoryRouteOptions;
  sessionSnapshotRoutes?: SessionSnapshotRouteOptions;
  sseReplayRoutes?: SseReplayRouteOptions;
  boardYjsHostProxyRoutes?: BoardYjsHostProxyRouteOptions;
};

export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const owners = options.routeOwners ?? routeOwnerManifest;

  if (options.exposeLocalHealthRoute) {
    app.get("/__orch_server_ts/health", async () => ({
      ok: true,
      package: "@soulstream/orch-server-ts",
      environment: options.config.environment,
      routeOwnersArtifactOnly: owners.artifactOnly,
    }));
  }
  if (options.nodeWsRoute !== undefined) {
    registerNodeWsRoute(app, options.nodeWsRoute);
  }
  if (options.nodeSnapshotRoutes !== undefined) {
    registerNodeSnapshotRoutes(app, options.nodeSnapshotRoutes);
  }
  if (options.sessionCommandRoutes !== undefined) {
    registerSessionCommandRoutes(app, options.sessionCommandRoutes);
  }
  if (options.sessionHistoryRoutes !== undefined) {
    registerSessionHistoryRoutes(app, options.sessionHistoryRoutes);
  }
  if (options.sessionSnapshotRoutes !== undefined) {
    registerSessionSnapshotRoutes(app, options.sessionSnapshotRoutes);
  }
  if (options.sseReplayRoutes !== undefined) {
    registerSseReplayRoutes(app, options.sseReplayRoutes);
  }
  if (options.boardYjsHostProxyRoutes !== undefined) {
    registerBoardYjsHostProxyRoutes(app, options.boardYjsHostProxyRoutes);
  }

  return app;
}

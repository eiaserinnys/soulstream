import type { FastifyInstance } from "fastify";

import { createApp } from "../app.js";
import type { OrchServerTsConfig } from "../config.js";
import type { RouteOwnerManifest } from "../contract/route_owner_manifest.js";
import type {
  BoardYjsHostHttpClient,
  BoardYjsHostProxyRouteOptions,
} from "../board/board_yjs_host_proxy.js";
import type {
  NodeCommandClock,
  NodeCommandRequestIdGenerator,
} from "../node/pending_commands.js";
import { InMemoryNodeRegistry } from "../node/registry.js";
import type { NodeWsRouteOptions } from "../node/ws_route.js";
import { NodeCommandTransportHub } from "../node/transport_hub.js";
import { createNodeSessionEventBroadcasterSink } from "./node_session_event_dispatcher.js";
import {
  SessionCommandRouter,
  type SessionCommandRouterOptions,
} from "../session/session_command_router.js";
import {
  SessionCommandTransportBridge,
  type SessionCommandTransportBridgeOptions,
} from "../session/session_command_transport.js";
import type { SessionCommandRouteOptions } from "../session/session_command_routes.js";
import {
  InMemorySseReplayBroadcaster,
  type SessionStreamEvent,
  type TaskStreamEvent,
} from "../sse/replay_broadcaster.js";
import type {
  SessionStreamSnapshot,
  SseReplayRouteOptions,
  TaskStreamSnapshot,
} from "../sse/sse_replay_routes.js";

export type OrchestratorRuntimeCompositionOptions = {
  config: OrchServerTsConfig;
  routeOwners?: RouteOwnerManifest;
  exposeLocalHealthRoute?: boolean;
  nowMs?: NodeCommandClock;
  requestIdGenerator?: NodeCommandRequestIdGenerator;
  heartbeatTimeoutMs?: number;
  commandTimeoutMs?: number;
  sessionSseInstanceId?: string;
  taskSseInstanceId?: string;
  sseRingMaxlen?: number;
  sseKeepaliveMs?: number;
  sseReplayOnlyForTests?: boolean;
  loadSessionSnapshot: () => Promise<SessionStreamSnapshot>;
  loadTaskSnapshot: () => Promise<TaskStreamSnapshot>;
  boardYjsHostHttpClient: BoardYjsHostHttpClient;
};

export type OrchestratorRuntimeRouteOptions = {
  nodeWsRoute: NodeWsRouteOptions;
  sessionCommandRoutes: SessionCommandRouteOptions;
  sseReplayRoutes: SseReplayRouteOptions;
  boardYjsHostProxyRoutes: BoardYjsHostProxyRouteOptions;
};

export type OrchestratorRuntimeComposition = {
  app: FastifyInstance;
  registry: InMemoryNodeRegistry;
  transports: NodeCommandTransportHub;
  sessionRouter: SessionCommandRouter;
  sessionBridge: SessionCommandTransportBridge;
  sessionBroadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>;
  taskBroadcaster: InMemorySseReplayBroadcaster<TaskStreamEvent>;
  routeOptions: OrchestratorRuntimeRouteOptions;
};

export function createOrchestratorRuntimeComposition(
  options: OrchestratorRuntimeCompositionOptions,
): OrchestratorRuntimeComposition {
  const registry = new InMemoryNodeRegistry({
    nowMs: options.nowMs,
    requestIdGenerator: options.requestIdGenerator,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
  });
  const transports = new NodeCommandTransportHub();
  const sessionRouter = new SessionCommandRouter({
    registry,
  } satisfies SessionCommandRouterOptions);
  const sessionBridge = new SessionCommandTransportBridge({
    registry,
    transports,
  } satisfies SessionCommandTransportBridgeOptions);
  const sessionBroadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
    instanceId: options.sessionSseInstanceId,
    ringMaxlen: options.sseRingMaxlen,
  });
  const taskBroadcaster = new InMemorySseReplayBroadcaster<TaskStreamEvent>({
    instanceId: options.taskSseInstanceId,
    ringMaxlen: options.sseRingMaxlen,
  });

  const routeOptions: OrchestratorRuntimeRouteOptions = {
    nodeWsRoute: {
      registry,
      transportHub: transports,
      eventSink: createNodeSessionEventBroadcasterSink(sessionBroadcaster),
    },
    sessionCommandRoutes: {
      router: sessionRouter,
      bridge: sessionBridge,
      timeoutMs: options.commandTimeoutMs,
    },
    sseReplayRoutes: {
      session: {
        broadcaster: sessionBroadcaster,
        loadSnapshot: options.loadSessionSnapshot,
      },
      task: {
        broadcaster: taskBroadcaster,
        loadSnapshot: options.loadTaskSnapshot,
      },
      keepaliveMs: options.sseKeepaliveMs,
      replayOnlyForTests: options.sseReplayOnlyForTests,
    },
    boardYjsHostProxyRoutes: {
      registry,
      httpClient: options.boardYjsHostHttpClient,
    },
  };

  const app = createApp({
    config: options.config,
    routeOwners: options.routeOwners,
    exposeLocalHealthRoute: options.exposeLocalHealthRoute,
    ...routeOptions,
  });

  return {
    app,
    registry,
    transports,
    sessionRouter,
    sessionBridge,
    sessionBroadcaster,
    taskBroadcaster,
    routeOptions,
  };
}

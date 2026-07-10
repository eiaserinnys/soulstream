import type { FastifyInstance, FastifyRequest } from "fastify";

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
import { InMemoryNodeRegistry, type NodeRegistryEvent } from "../node/registry.js";
import { NodeSnapshotService } from "../node/node_snapshot_service.js";
import {
  InMemoryNodeStreamBroadcaster,
  createNodeStreamBroadcasterSink,
  type NodeSnapshotRouteOptions,
} from "../node/node_snapshot_routes.js";
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
import type { SessionActionCommandRouteOptions } from "../session/session_action_command_routes.js";
import type { SessionBackgroundScheduleRouteOptions } from "../session/session_background_schedule_routes.js";
import type { SessionCommandRouteOptions } from "../session/session_command_routes.js";
import type { SessionHistoryRouteOptions } from "../session/session_history_routes.js";
import type { SessionHistoryProvider } from "../session/session_history_service.js";
import { SessionSnapshotService } from "../session/session_snapshot_service.js";
import type { SessionSnapshotRouteOptions } from "../session/session_snapshot_routes.js";
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
import {
  createLiveNodeHttpClientBoundary,
  type LiveNodeHttpFetch,
} from "./live_node_http_client.js";
import type { LiveNodeHttpClientBoundary } from "./live_provider_dependencies.js";
import {
  RuntimeSessionEventHub,
  createRuntimeSessionEventHubSink,
} from "./session_event_hub.js";

export type OrchestratorRuntimeCompositionOptions = {
  config: OrchServerTsConfig;
  registry?: InMemoryNodeRegistry;
  routeOwners?: RouteOwnerManifest;
  exposeLocalHealthRoute?: boolean;
  nowMs?: NodeCommandClock;
  requestIdGenerator?: NodeCommandRequestIdGenerator;
  commandTimeoutMs?: number;
  enableSessionActionCommandRoutes?: boolean;
  enableSessionBackgroundScheduleRoutes?: boolean;
  sessionSseInstanceId?: string;
  taskSseInstanceId?: string;
  sseRingMaxlen?: number;
  sseKeepaliveMs?: number;
  sseReplayOnlyForTests?: boolean;
  nodeStreamKeepaliveMs?: number;
  nodeStreamCloseAfterInitialSnapshot?: boolean;
  loadSessionSnapshot?: (request: FastifyRequest) => Promise<SessionStreamSnapshot>;
  sessionHistoryProvider?: SessionHistoryProvider;
  sessionHistoryKeepaliveMs?: number;
  sessionHistoryCloseAfterHistorySync?: boolean;
  loadTaskSnapshot: () => Promise<TaskStreamSnapshot>;
  boardYjsHostHttpClient?: BoardYjsHostHttpClient;
  nodeHttpFetch?: LiveNodeHttpFetch;
  nodeHttpRequestTimeoutMs?: number;
};

export type OrchestratorRuntimeRouteOptions = {
  nodeWsRoute: NodeWsRouteOptions;
  nodeSnapshotRoutes: NodeSnapshotRouteOptions;
  sessionActionCommandRoutes?: SessionActionCommandRouteOptions;
  sessionBackgroundScheduleRoutes?: SessionBackgroundScheduleRouteOptions;
  sessionCommandRoutes: SessionCommandRouteOptions;
  sessionHistoryRoutes?: SessionHistoryRouteOptions;
  sessionSnapshotRoutes: SessionSnapshotRouteOptions;
  sseReplayRoutes: SseReplayRouteOptions;
  boardYjsHostProxyRoutes: BoardYjsHostProxyRouteOptions;
};

export type OrchestratorRuntimeServices = {
  registry: InMemoryNodeRegistry;
  transports: NodeCommandTransportHub;
  sessionRouter: SessionCommandRouter;
  sessionBridge: SessionCommandTransportBridge;
  nodeSnapshotService: NodeSnapshotService;
  nodeStreamBroadcaster: InMemoryNodeStreamBroadcaster;
  sessionSnapshotService: SessionSnapshotService;
  sessionEventHub: RuntimeSessionEventHub;
  sessionBroadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>;
  taskBroadcaster: InMemorySseReplayBroadcaster<TaskStreamEvent>;
  nodeHttpClient: LiveNodeHttpClientBoundary;
  routeOptions: OrchestratorRuntimeRouteOptions;
};

export type OrchestratorRuntimeComposition = OrchestratorRuntimeServices & {
  app: FastifyInstance;
};

export function createOrchestratorRuntimeServices(
  options: OrchestratorRuntimeCompositionOptions,
): OrchestratorRuntimeServices {
  const registry = options.registry ?? new InMemoryNodeRegistry({
    nowMs: options.nowMs,
    requestIdGenerator: options.requestIdGenerator,
  });
  const transports = new NodeCommandTransportHub();
  const sessionRouter = new SessionCommandRouter({
    registry,
  } satisfies SessionCommandRouterOptions);
  const sessionBridge = new SessionCommandTransportBridge({
    registry,
    transports,
  } satisfies SessionCommandTransportBridgeOptions);
  const nodeSnapshotService = new NodeSnapshotService({ registry });
  const nodeStreamBroadcaster = new InMemoryNodeStreamBroadcaster({
    snapshotService: nodeSnapshotService,
  });
  const sessionSnapshotService = new SessionSnapshotService({ registry });
  const sessionEventHub = new RuntimeSessionEventHub();
  const sessionBroadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
    instanceId: options.sessionSseInstanceId,
    ringMaxlen: options.sseRingMaxlen,
  });
  const taskBroadcaster = new InMemorySseReplayBroadcaster<TaskStreamEvent>({
    instanceId: options.taskSseInstanceId,
    ringMaxlen: options.sseRingMaxlen,
  });
  const nodeHttpClient = createLiveNodeHttpClientBoundary({
    registry,
    fetch: options.nodeHttpFetch,
    timeoutMs: options.nodeHttpRequestTimeoutMs,
  });

  const routeOptions: OrchestratorRuntimeRouteOptions = {
    nodeWsRoute: {
      registry,
      transportHub: transports,
      eventSink: composeEventSinks(
        createRuntimeSessionEventHubSink(sessionEventHub),
        createNodeSessionEventBroadcasterSink(sessionBroadcaster),
        createNodeStreamBroadcasterSink(nodeStreamBroadcaster),
      ),
    },
    nodeSnapshotRoutes: {
      snapshotService: nodeSnapshotService,
      broadcaster: nodeStreamBroadcaster,
      keepaliveMs: options.nodeStreamKeepaliveMs,
      closeAfterInitialSnapshot: options.nodeStreamCloseAfterInitialSnapshot,
    },
    sessionCommandRoutes: {
      router: sessionRouter,
      bridge: sessionBridge,
      timeoutMs: options.commandTimeoutMs,
    },
    ...(options.enableSessionActionCommandRoutes === true
      ? {
          sessionActionCommandRoutes: {
            router: sessionRouter,
            bridge: sessionBridge,
            timeoutMs: options.commandTimeoutMs,
          },
        }
      : {}),
    ...(options.enableSessionBackgroundScheduleRoutes === true
      ? {
          sessionBackgroundScheduleRoutes: {
            router: sessionRouter,
            bridge: sessionBridge,
            timeoutMs: options.commandTimeoutMs,
          },
        }
      : {}),
    ...(options.sessionHistoryProvider === undefined
      ? {}
      : {
          sessionHistoryRoutes: {
            provider: options.sessionHistoryProvider,
            keepaliveMs: options.sessionHistoryKeepaliveMs,
            closeAfterHistorySync: options.sessionHistoryCloseAfterHistorySync,
          },
        }),
    sessionSnapshotRoutes: {
      snapshotService: sessionSnapshotService,
    },
    sseReplayRoutes: {
      session: {
        broadcaster: sessionBroadcaster,
        loadSnapshot:
          options.loadSessionSnapshot ??
          (() => sessionSnapshotService.loadSessionStreamSnapshot()),
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
      httpClient:
        options.boardYjsHostHttpClient ?? nodeHttpClient.boardYjsHostHttpClient,
    },
  };

  return {
    registry,
    transports,
    sessionRouter,
    sessionBridge,
    nodeSnapshotService,
    nodeStreamBroadcaster,
    sessionSnapshotService,
    sessionEventHub,
    sessionBroadcaster,
    taskBroadcaster,
    nodeHttpClient,
    routeOptions,
  };
}

export function createOrchestratorRuntimeComposition(
  options: OrchestratorRuntimeCompositionOptions,
): OrchestratorRuntimeComposition {
  const services = createOrchestratorRuntimeServices(options);
  const app = createApp({
    config: options.config,
    routeOwners: options.routeOwners,
    exposeLocalHealthRoute: options.exposeLocalHealthRoute,
    ...services.routeOptions,
  });

  return {
    app,
    ...services,
  };
}

function composeEventSinks(
  ...sinks: Array<(events: NodeRegistryEvent[]) => void>
): NonNullable<NodeWsRouteOptions["eventSink"]> {
  return (events) => {
    for (const sink of sinks) {
      sink(events);
    }
  };
}

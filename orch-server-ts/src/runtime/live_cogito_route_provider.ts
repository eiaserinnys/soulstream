import type {
  CogitoBriefCollector,
  CogitoNode,
  CogitoNodeProvider,
  CogitoSearchHttpClient,
  CogitoSearchHttpRequest,
} from "../cogito/cogito_routes.js";
import {
  CogitoBriefTimeoutError,
  CogitoBriefUnavailableError,
} from "../cogito/cogito_routes.js";
import {
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
  type NodeCommandResponse,
  type PendingNodeCommand,
  type RequestResponseNodeCommandPayload,
} from "../node/pending_commands.js";
import type { NodeConnectionSnapshot } from "../node/registry_types.js";
import {
  NodeCommandTransportError,
  type SessionCommandTransportBridge,
} from "../session/session_command_transport.js";
import type { LiveNodeHttpClientBoundary } from "./live_provider_dependencies.js";

export type LiveCogitoNodeRegistry = {
  readonly listConnectedNodes: () => readonly NodeConnectionSnapshot[];
};

export type LiveCogitoBriefRegistry = {
  readonly getConnectedNode: (nodeId: string) => NodeConnectionSnapshot | undefined;
  readonly createCommand: <
    TPayload extends RequestResponseNodeCommandPayload,
    TResponse extends NodeCommandResponse = NodeCommandResponse,
  >(
    nodeId: string,
    payload: TPayload,
    options?: { timeoutMs?: number },
  ) => PendingNodeCommand<TPayload, TResponse>;
};

export type CreateLiveCogitoRouteProviderOptions = {
  readonly registry: LiveCogitoNodeRegistry;
};

export type LiveCogitoNodeHttpClient = Pick<
  LiveNodeHttpClientBoundary,
  "requestNode"
>;

export type CreateLiveCogitoRouteHttpClientOptions = {
  readonly nodeHttpClient: LiveCogitoNodeHttpClient;
};

export type LiveCogitoCommandBridge = Pick<
  SessionCommandTransportBridge,
  "sendPendingCommand"
>;

export type CreateLiveCogitoBriefCollectorOptions = {
  readonly registry: LiveCogitoBriefRegistry;
  readonly bridge: LiveCogitoCommandBridge;
};

export type CreateLiveCogitoRouteProvidersOptions =
  CreateLiveCogitoRouteProviderOptions &
  CreateLiveCogitoRouteHttpClientOptions &
  CreateLiveCogitoBriefCollectorOptions;

export type LiveCogitoRouteProviderBundle = {
  readonly cogitoRoutes: {
    readonly provider: CogitoNodeProvider;
    readonly httpClient: CogitoSearchHttpClient;
    readonly briefCollector: CogitoBriefCollector;
  };
};

export function createLiveCogitoRouteProvider(
  options: CreateLiveCogitoRouteProviderOptions,
): CogitoNodeProvider {
  return {
    listConnectedNodes: () => listConnectedNodes(options.registry),
  };
}

export function createLiveCogitoRouteProviders(
  options: CreateLiveCogitoRouteProvidersOptions,
): LiveCogitoRouteProviderBundle {
  return {
    cogitoRoutes: {
      provider: createLiveCogitoRouteProvider(options),
      httpClient: createLiveCogitoSearchHttpClient(options),
      briefCollector: createLiveCogitoBriefCollector(options),
    },
  };
}

export function createLiveCogitoSearchHttpClient(
  options: CreateLiveCogitoRouteHttpClientOptions,
): CogitoSearchHttpClient {
  return {
    get: async (request) => {
      const response = await options.nodeHttpClient.requestNode({
        nodeId: request.nodeId,
        method: "GET",
        path: cogitoSearchPath(request),
        headers: request.headers,
      });
      return {
        statusCode: response.statusCode,
        body: response.body,
      };
    },
  };
}

export function createLiveCogitoBriefCollector(
  options: CreateLiveCogitoBriefCollectorOptions,
): CogitoBriefCollector {
  return {
    reflectBrief: async (node, timeoutSeconds) => {
      const current = options.registry.getConnectedNode(node.id);
      if (current === undefined) {
        throw unavailableError(`Node is not connected: ${node.id}`);
      }

      const command = options.registry.createCommand<
        ReflectBriefCommandPayload,
        ReflectBriefCommandResponse
      >(node.id, { type: "reflect_brief" }, {
        timeoutMs: briefTimeoutMs(timeoutSeconds),
      });

      try {
        return await options.bridge.sendPendingCommand({
          node: current,
          command,
        });
      } catch (error) {
        throw mapReflectBriefCommandError(error);
      }
    },
  };
}

function listConnectedNodes(registry: LiveCogitoNodeRegistry): CogitoNode[] {
  return registry.listConnectedNodes().map((node) => ({
    id: node.nodeId,
    host: node.host,
    port: node.port,
    capabilities: { ...node.capabilities },
  }));
}

function cogitoSearchPath(request: CogitoSearchHttpRequest): string {
  const query = new URLSearchParams();
  query.set("q", request.params.q);
  query.set("top_k", String(request.params.top_k));
  query.set("search_session_id", String(request.params.search_session_id));
  if (request.params.event_types !== undefined) {
    query.set("event_types", request.params.event_types);
  }
  return `/cogito/search?${query.toString()}`;
}

type ReflectBriefCommandPayload = RequestResponseNodeCommandPayload<"reflect_brief">;

type ReflectBriefCommandResponse = NodeCommandResponse & {
  type: "reflect_brief";
  ok?: unknown;
  checked_at?: unknown;
  brief?: unknown;
};

function briefTimeoutMs(timeoutSeconds: number): number {
  const timeoutMs = Math.ceil(timeoutSeconds * 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`brief timeoutSeconds must be positive: ${timeoutSeconds}`);
  }
  return timeoutMs;
}

function mapReflectBriefCommandError(error: unknown): unknown {
  if (error instanceof PendingNodeCommandTimeoutError) {
    return new CogitoBriefTimeoutError(error.message);
  }
  if (error instanceof NodeCommandTransportError) {
    return unavailableError(error.message);
  }
  if (
    error instanceof PendingNodeCommandRejectedError &&
    error.message.startsWith("Node disconnected:")
  ) {
    return unavailableError(error.message);
  }
  return error;
}

function unavailableError(message: string): CogitoBriefUnavailableError {
  return new CogitoBriefUnavailableError(message);
}

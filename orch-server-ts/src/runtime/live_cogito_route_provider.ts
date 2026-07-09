import type {
  CogitoNode,
  CogitoNodeProvider,
  CogitoSearchHttpClient,
  CogitoSearchHttpRequest,
} from "../cogito/cogito_routes.js";
import type { NodeConnectionSnapshot } from "../node/registry_types.js";
import type { LiveNodeHttpClientBoundary } from "./live_provider_dependencies.js";

export type LiveCogitoNodeRegistry = {
  readonly listConnectedNodes: () => readonly NodeConnectionSnapshot[];
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

export type CreateLiveCogitoRouteProvidersOptions =
  CreateLiveCogitoRouteProviderOptions & CreateLiveCogitoRouteHttpClientOptions;

export type LiveCogitoRouteProviderBundle = {
  readonly cogitoRoutes: {
    readonly provider: CogitoNodeProvider;
    readonly httpClient: CogitoSearchHttpClient;
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

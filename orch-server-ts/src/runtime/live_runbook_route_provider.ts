import type {
  RunbookMutationHttpClient,
  RunbookRouteOptions,
} from "../runbooks/runbook_route_types.js";
import type { LiveNodeHttpClientBoundary } from "./live_provider_dependencies.js";

export type LiveRunbookNodeHttpClient = Pick<
  LiveNodeHttpClientBoundary,
  "requestNode"
>;

export type CreateLiveRunbookRouteProviderOptions = {
  readonly nodeHttpClient: LiveRunbookNodeHttpClient;
};

export type LiveRunbookRouteProviderBundle = {
  readonly runbookRoutes: Pick<RunbookRouteOptions, "httpClient">;
};

export function createLiveRunbookRouteProviders(
  options: CreateLiveRunbookRouteProviderOptions,
): LiveRunbookRouteProviderBundle {
  return {
    runbookRoutes: {
      httpClient: createLiveRunbookMutationHttpClient(options),
    },
  };
}

export function createLiveRunbookMutationHttpClient(
  options: CreateLiveRunbookRouteProviderOptions,
): RunbookMutationHttpClient {
  return async (request) => {
    const response = await options.nodeHttpClient.requestNode({
      nodeId: request.target.nodeId,
      method: request.method,
      path: request.upstreamPath,
      headers: request.headers,
      body: request.body,
    });
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
    };
  };
}

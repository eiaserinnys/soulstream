import type {
  NodeClaudeAuthHttpClient,
  NodeClaudeAuthRouteOptions,
} from "../node/node_claude_auth_routes.js";
import type { LiveNodeHttpClientBoundary } from "./live_provider_dependencies.js";

export type LiveNodeClaudeAuthNodeHttpClient = Pick<
  LiveNodeHttpClientBoundary,
  "requestNode"
>;

export type CreateLiveNodeClaudeAuthRouteProviderOptions = {
  readonly nodeHttpClient: LiveNodeClaudeAuthNodeHttpClient;
};

export type LiveNodeClaudeAuthRouteProviderBundle = {
  readonly nodeClaudeAuthRoutes: Pick<NodeClaudeAuthRouteOptions, "profileHttpClient">;
};

export function createLiveNodeClaudeAuthRouteProviders(
  options: CreateLiveNodeClaudeAuthRouteProviderOptions,
): LiveNodeClaudeAuthRouteProviderBundle {
  return {
    nodeClaudeAuthRoutes: {
      profileHttpClient: createLiveNodeClaudeAuthProfileHttpClient(options),
    },
  };
}

export function createLiveNodeClaudeAuthProfileHttpClient(
  options: CreateLiveNodeClaudeAuthRouteProviderOptions,
): NodeClaudeAuthHttpClient {
  return async (request) => {
    const response = await options.nodeHttpClient.requestNode({
      nodeId: request.node.nodeId,
      method: request.method,
      path: request.path,
      headers: request.headers,
    });
    return {
      statusCode: response.statusCode,
      body: response.body,
    };
  };
}

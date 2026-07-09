import type {
  NodeClaudeAuthHttpClient,
  NodeClaudeAuthRouteProvider,
  NodeClaudeAuthRouteOptions,
} from "../node/node_claude_auth_routes.js";
import type {
  LiveConfigProviderBoundary,
  LiveNodeHttpClientBoundary,
} from "./live_provider_dependencies.js";
import {
  LiveConfigProviderError,
  type LiveConfigProviderFailure,
} from "./live_config_route_providers.js";

export type LiveNodeClaudeAuthNodeHttpClient = Pick<
  LiveNodeHttpClientBoundary,
  "requestNode"
>;

export type LiveNodeClaudeAuthConfigProvider = Pick<
  LiveConfigProviderBoundary,
  "requireConfig"
>;

export type CreateLiveNodeClaudeAuthRouteProviderOptions = {
  readonly nodeHttpClient: LiveNodeClaudeAuthNodeHttpClient;
  readonly configProvider: LiveNodeClaudeAuthConfigProvider;
};

export type CreateLiveNodeClaudeAuthProfileHttpClientOptions = {
  readonly nodeHttpClient: LiveNodeClaudeAuthNodeHttpClient;
};

export type CreateLiveNodeClaudeAuthOAuthConfigProviderOptions = {
  readonly configProvider: LiveNodeClaudeAuthConfigProvider;
};

export type LiveNodeClaudeAuthRouteProviderBundle = {
  readonly nodeClaudeAuthRoutes: Pick<
    NodeClaudeAuthRouteOptions,
    "profileHttpClient" | "provider"
  >;
};

export function createLiveNodeClaudeAuthRouteProviders(
  options: CreateLiveNodeClaudeAuthRouteProviderOptions,
): LiveNodeClaudeAuthRouteProviderBundle {
  return {
    nodeClaudeAuthRoutes: {
      provider: createLiveNodeClaudeAuthOAuthConfigProvider(options),
      profileHttpClient: createLiveNodeClaudeAuthProfileHttpClient(options),
    },
  };
}

export function createLiveNodeClaudeAuthOAuthConfigProvider(
  options: CreateLiveNodeClaudeAuthOAuthConfigProviderOptions,
): NodeClaudeAuthRouteProvider {
  return {
    getOAuthConfig: async () => {
      const [clientId, callbackUrl] = await Promise.all([
        requireClaudeAuthString(options.configProvider, "claude_oauth_client_id"),
        requireClaudeAuthString(
          options.configProvider,
          "claude_oauth_callback_url",
        ),
      ]);
      return { clientId, callbackUrl };
    },
  };
}

export function createLiveNodeClaudeAuthProfileHttpClient(
  options: CreateLiveNodeClaudeAuthProfileHttpClientOptions,
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

async function requireClaudeAuthString(
  configProvider: LiveNodeClaudeAuthConfigProvider,
  key: string,
): Promise<string> {
  let value: unknown;
  try {
    value = await configProvider.requireConfig(key);
  } catch {
    throw new LiveConfigProviderError([
      claudeAuthConfigFailure(key, "missing", "string", undefined),
    ]);
  }
  if (value === undefined || value === null) {
    throw new LiveConfigProviderError([
      claudeAuthConfigFailure(key, "missing", "string", value),
    ]);
  }
  if (typeof value !== "string") {
    throw new LiveConfigProviderError([
      claudeAuthConfigFailure(key, "invalid_type", "string", value),
    ]);
  }
  return value;
}

function claudeAuthConfigFailure(
  key: string,
  reason: LiveConfigProviderFailure["reason"],
  expected: string,
  actual: unknown,
): LiveConfigProviderFailure {
  return {
    owner: "node.claude-auth",
    path: "nodeClaudeAuthRoutes.provider",
    key,
    reason,
    expected,
    actualType: actualType(actual),
  };
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

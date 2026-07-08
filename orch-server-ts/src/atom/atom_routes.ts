import type { FastifyInstance, FastifyReply } from "fastify";

export const ATOM_INTEGRATION_DISABLED_DETAIL = "atom integration not enabled";
export const ATOM_API_UNAVAILABLE_DETAIL = "atom API unavailable";
export const ATOM_NODE_NOT_FOUND_DETAIL = "Node not found";

export type AtomRouteConfig = {
  atomEnabled: boolean;
  atomServerUrl: string;
  atomApiKey: string;
  atomRootNodeId?: string | null;
};

export type AtomRouteConfigProvider = {
  getConfig: () => AtomRouteConfig | Promise<AtomRouteConfig>;
};

export type AtomHttpRequest = {
  url: string;
  headers: Record<string, string>;
};

export type AtomHttpResponse = {
  statusCode: number;
  body: unknown;
};

export type AtomHttpClient = {
  get: (request: AtomHttpRequest) => Promise<AtomHttpResponse>;
};

export type AtomRouteOptions = {
  configProvider: AtomRouteConfigProvider;
  httpClient: AtomHttpClient;
};

export const atomRouteAuthRequirements = {
  "GET /api/atom/nodes": true,
  "GET /api/atom/nodes/:node_id/children": true,
} as const;

export function registerAtomRoutes(app: FastifyInstance, options: AtomRouteOptions): void {
  app.get("/api/atom/nodes", async (_request, reply) => {
    const config = await options.configProvider.getConfig();
    if (!isAtomIntegrationEnabled(config)) {
      return routeError(reply, 503, ATOM_INTEGRATION_DISABLED_DETAIL);
    }

    const path = config.atomRootNodeId
      ? `/api/tree/${encodePathSegment(config.atomRootNodeId)}/children`
      : "/api/tree";
    return fetchAtomChildren(reply, options.httpClient, config, path, {
      preserveNotFound: false,
    });
  });

  app.get<{ Params: { node_id: string } }>(
    "/api/atom/nodes/:node_id/children",
    async (request, reply) => {
      const config = await options.configProvider.getConfig();
      if (!isAtomIntegrationEnabled(config)) {
        return routeError(reply, 503, ATOM_INTEGRATION_DISABLED_DETAIL);
      }

      return fetchAtomChildren(
        reply,
        options.httpClient,
        config,
        `/api/tree/${encodePathSegment(request.params.node_id)}/children`,
        { preserveNotFound: true },
      );
    },
  );
}

async function fetchAtomChildren(
  reply: FastifyReply,
  httpClient: AtomHttpClient,
  config: AtomRouteConfig,
  path: string,
  options: { preserveNotFound: boolean },
): Promise<FastifyReply | { children: unknown }> {
  try {
    const response = await httpClient.get({
      url: `${normalizeAtomBaseUrl(config.atomServerUrl)}${path}`,
      headers: { "x-api-key": config.atomApiKey },
    });

    if (options.preserveNotFound && response.statusCode === 404) {
      return routeError(reply, 404, ATOM_NODE_NOT_FOUND_DETAIL);
    }
    if (!isSuccessStatus(response.statusCode) || response.body === undefined) {
      return routeError(reply, 502, ATOM_API_UNAVAILABLE_DETAIL);
    }
    return { children: response.body };
  } catch {
    return routeError(reply, 502, ATOM_API_UNAVAILABLE_DETAIL);
  }
}

function isAtomIntegrationEnabled(config: AtomRouteConfig): boolean {
  return config.atomEnabled && config.atomServerUrl.length > 0;
}

function normalizeAtomBaseUrl(value: string): string {
  return value.replace(/\/+$/u, "");
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function isSuccessStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

function routeError(reply: FastifyReply, statusCode: number, detail: string): FastifyReply {
  return reply.code(statusCode).send({ detail });
}

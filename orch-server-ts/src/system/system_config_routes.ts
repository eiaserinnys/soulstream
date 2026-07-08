import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type SystemPortraitSource = "system" | "channel_observer" | "trello_watcher";

export type SystemPortraitBody = string | Buffer | Uint8Array;

export type SystemPortraitResult = {
  body: SystemPortraitBody;
  encoding?: "base64";
};

export type SystemConfigNodeCandidate = {
  nodeId: string;
  host: string;
  port: number;
};

export type SystemConfigHttpRequest = {
  method: "GET" | "PUT";
  url: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  node: SystemConfigNodeCandidate;
};

export type SystemConfigHttpResponse = {
  statusCode: number;
  headers?: Record<string, string | undefined>;
  body?: unknown;
};

export type SystemConfigHttpClient = (
  request: SystemConfigHttpRequest,
) => Promise<SystemConfigHttpResponse>;

export type SystemConfigRouteProvider = {
  getSystemPortrait: (
    source: SystemPortraitSource,
  ) => Promise<SystemPortraitResult | undefined>;
  listConnectedNodes: () =>
    | Promise<readonly SystemConfigNodeCandidate[]>
    | readonly SystemConfigNodeCandidate[];
};

export type SystemConfigRouteOptions = {
  provider: SystemConfigRouteProvider;
  httpClient: SystemConfigHttpClient;
};

const ALLOWED_SYSTEM_PORTRAIT_SOURCES = new Set<SystemPortraitSource>([
  "system",
  "channel_observer",
  "trello_watcher",
]);

const UNSUPPORTED_PATH_STATUS_CODES = new Set([404, 405]);

const DEFAULT_DASHBOARD_CONFIG = {
  user: { name: "User", id: "", hasPortrait: false },
  agents: [],
};

export const systemConfigRouteAuthRequirements = {
  "GET /api/system/portraits/:source": true,
  "GET /api/config/settings": true,
  "PUT /api/config/settings": true,
  "GET /api/dashboard/config": true,
} as const;

export function registerSystemConfigRoutes(
  app: FastifyInstance,
  options: SystemConfigRouteOptions,
): void {
  app.get<{ Params: { source: string } }>(
    "/api/system/portraits/:source",
    async (request, reply) => {
      const source = request.params.source;
      if (!isSystemPortraitSource(source)) {
        return reply.code(404).send({
          detail: `Unknown system portrait source: ${source}`,
        });
      }
      const result = await options.provider.getSystemPortrait(source);
      if (result === undefined) {
        return reply.code(404).send({ detail: "Portrait asset not found" });
      }
      return reply
        .header("Cache-Control", "public, max-age=3600")
        .type("image/png")
        .send(decodeBody(result.body, result.encoding));
    },
  );

  app.get("/api/config/settings", async (request, reply) => {
    const result = await requestFirstSupportedNode(
      options,
      request,
      "GET",
      "/api/config/settings",
    );
    if (result === undefined) {
      return reply.send({ categories: [] });
    }
    return sendUpstreamResponse(reply, result.response);
  });

  app.put("/api/config/settings", async (request, reply) => {
    const result = await requestFirstSupportedNode(
      options,
      request,
      "PUT",
      "/api/config/settings",
      request.body,
    );
    if (result === undefined) {
      return reply
        .code(503)
        .send({ detail: "설정을 저장할 수 있는 노드가 없습니다" });
    }
    return sendUpstreamResponse(reply, result.response);
  });

  app.get("/api/dashboard/config", async (request, reply) => {
    const result = await requestFirstSupportedNode(
      options,
      request,
      "GET",
      "/api/dashboard/config",
    );
    if (result === undefined) {
      return reply.send(DEFAULT_DASHBOARD_CONFIG);
    }
    if (result.response.statusCode !== 200) {
      return sendUpstreamResponse(reply, result.response);
    }
    return reply.send(withDashboardPortraitUrl(result.response.body, result.node.nodeId));
  });
}

async function requestFirstSupportedNode(
  options: SystemConfigRouteOptions,
  request: FastifyRequest,
  method: "GET" | "PUT",
  path: string,
  body?: unknown,
): Promise<
  | { response: SystemConfigHttpResponse; node: SystemConfigNodeCandidate }
  | undefined
> {
  const nodes = await options.provider.listConnectedNodes();
  if (nodes.length === 0) return undefined;
  const headers = forwardAuthHeaders(request);

  for (const node of nodes) {
    const upstreamRequest: SystemConfigHttpRequest = {
      method,
      url: `http://${node.host}:${node.port}${path}`,
      path,
      headers,
      node,
      ...(method === "PUT" ? { body } : {}),
    };
    try {
      const response = await options.httpClient(upstreamRequest);
      if (UNSUPPORTED_PATH_STATUS_CODES.has(response.statusCode)) continue;
      return { response, node };
    } catch {
      continue;
    }
  }

  return undefined;
}

function sendUpstreamResponse(
  reply: FastifyReply,
  response: SystemConfigHttpResponse,
): FastifyReply {
  const contentType = headerValue(response.headers, "content-type");
  if (contentType !== undefined) {
    reply.header("content-type", contentType);
  }
  if (response.body === undefined) {
    return reply.code(response.statusCode).send();
  }
  return reply.code(response.statusCode).send(response.body);
}

function withDashboardPortraitUrl(body: unknown, nodeId: string): unknown {
  if (!isRecord(body)) return body;
  if (!isRecord(body.user) || !body.user.hasPortrait) return body;
  return {
    ...body,
    user: {
      ...body.user,
      portraitUrl: `/api/nodes/${nodeId}/user/portrait`,
    },
  };
}

function forwardAuthHeaders(request: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  const cookie = firstHeader(request.headers.cookie);
  if (cookie !== undefined) headers.cookie = cookie;
  const authorization = firstHeader(request.headers.authorization);
  if (authorization !== undefined) headers.authorization = authorization;
  return headers;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function headerValue(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  const targetName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === targetName) return value;
  }
  return undefined;
}

function isSystemPortraitSource(source: string): source is SystemPortraitSource {
  return ALLOWED_SYSTEM_PORTRAIT_SOURCES.has(source as SystemPortraitSource);
}

function decodeBody(body: SystemPortraitBody, encoding?: "base64"): Buffer {
  if (typeof body === "string" && encoding === "base64") {
    return Buffer.from(body, "base64");
  }
  if (typeof body === "string") return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

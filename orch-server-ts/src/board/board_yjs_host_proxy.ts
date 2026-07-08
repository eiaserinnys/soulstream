import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type {
  InMemoryNodeRegistry,
  NodeConnectionSnapshot,
} from "../node/registry.js";

export type BoardYjsHostTarget = {
  host: string;
  port: number;
  nodeId: string;
  connectionId: string;
};

export type BoardYjsHostHttpRequest = {
  method: "POST";
  url: string;
  upstreamPath: string;
  headers: Record<string, string>;
  body: unknown;
  target: BoardYjsHostTarget;
};

export type BoardYjsHostHttpResponse = {
  statusCode: number;
  headers?: Record<string, string | undefined>;
  body?: unknown;
};

export type BoardYjsHostHttpClient = (
  request: BoardYjsHostHttpRequest,
) => Promise<BoardYjsHostHttpResponse>;

export type BoardYjsHostProxyRouteOptions = {
  registry: InMemoryNodeRegistry;
  httpClient: BoardYjsHostHttpClient;
};

export const boardYjsHostProxyRouteAuthRequirements = {
  "POST /api/markdown-documents": true,
  "POST /api/board-yjs/host/{operation}": true,
} as const;

export class BoardYjsHostProxyError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly target: BoardYjsHostTarget | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    target?: BoardYjsHostTarget,
  ) {
    super(message);
    this.name = "BoardYjsHostProxyError";
    this.statusCode = statusCode;
    this.code = code;
    this.target = target;
  }
}

export function resolveBoardYjsHostTarget(
  registry: InMemoryNodeRegistry,
): BoardYjsHostTarget {
  const hosts = registry
    .listConnectedNodes()
    .filter((node) => node.capabilities.board_yjs_host === true);

  if (hosts.length === 0) {
    throw new BoardYjsHostProxyError(
      503,
      "BOARD_YJS_HOST_UNAVAILABLE",
      "Board Yjs host node is not connected",
    );
  }
  if (hosts.length > 1) {
    throw new BoardYjsHostProxyError(
      503,
      "BOARD_YJS_HOST_AMBIGUOUS",
      "Multiple Board Yjs host nodes are registered",
    );
  }

  const host = hosts[0];
  if (host === undefined) {
    throw new BoardYjsHostProxyError(
      503,
      "BOARD_YJS_HOST_UNAVAILABLE",
      "Board Yjs host node is not connected",
    );
  }
  return targetFromNode(host);
}

export function registerBoardYjsHostProxyRoutes(
  app: FastifyInstance,
  options: BoardYjsHostProxyRouteOptions,
): void {
  app.post("/api/markdown-documents", async (request, reply) =>
    proxyBoardYjsHostRequest(request, reply, options, "/api/markdown-documents"),
  );

  app.post<{ Params: { operation: string } }>(
    "/api/board-yjs/host/:operation",
    async (request, reply) =>
      proxyBoardYjsHostRequest(
        request,
        reply,
        options,
        `/api/internal/board-yjs/${encodeURIComponent(request.params.operation)}`,
      ),
  );
}

async function proxyBoardYjsHostRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: BoardYjsHostProxyRouteOptions,
  upstreamPath: string,
): Promise<FastifyReply> {
  try {
    const target = resolveBoardYjsHostTarget(options.registry);
    const response = await requestHost(options, {
      method: "POST",
      url: `http://${target.host}:${target.port}${upstreamPath}`,
      upstreamPath,
      headers: forwardAuthorizationHeader(request),
      body: request.body,
      target,
    });
    return sendHostResponse(reply, response);
  } catch (error) {
    return sendProxyError(reply, error);
  }
}

async function requestHost(
  options: BoardYjsHostProxyRouteOptions,
  request: BoardYjsHostHttpRequest,
): Promise<BoardYjsHostHttpResponse> {
  try {
    return await options.httpClient(request);
  } catch (error) {
    throw new BoardYjsHostProxyError(
      502,
      "BOARD_YJS_HOST_REQUEST_FAILED",
      error instanceof Error ? error.message : String(error),
      request.target,
    );
  }
}

function sendHostResponse(
  reply: FastifyReply,
  response: BoardYjsHostHttpResponse,
): FastifyReply {
  const contentType = headerValue(response.headers, "content-type");
  if (contentType !== undefined) {
    reply.header("content-type", contentType);
  }
  if (isJsonContentType(contentType)) {
    return reply.code(response.statusCode).send(response.body ?? null);
  }
  if (response.body === undefined) {
    return reply.code(response.statusCode).send();
  }
  return reply.code(response.statusCode).send(response.body);
}

function sendProxyError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof BoardYjsHostProxyError) {
    return reply.code(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
        nodeId: error.target?.nodeId,
        connectionId: error.target?.connectionId,
      },
    });
  }

  return reply.code(500).send({
    error: {
      code: "BOARD_YJS_HOST_PROXY_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function targetFromNode(node: NodeConnectionSnapshot): BoardYjsHostTarget {
  return {
    host: node.host,
    port: node.port,
    nodeId: node.nodeId,
    connectionId: node.connectionId,
  };
}

function forwardAuthorizationHeader(request: FastifyRequest): Record<string, string> {
  const authorization = request.headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  return typeof value === "string" ? { authorization: value } : {};
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

function isJsonContentType(contentType: string | undefined): boolean {
  return contentType?.toLowerCase().includes("application/json") ?? false;
}

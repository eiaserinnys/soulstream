import type {
  BoardYjsHostHttpClient,
  BoardYjsHostTarget,
} from "../board/board_yjs_host_proxy.js";
import type { NodeConnectionSnapshot } from "../node/registry_types.js";
import type {
  LiveNodeHttpClientBoundary,
  LiveNodeHttpRequest,
  LiveNodeHttpResponse,
} from "./live_provider_dependencies.js";

export type LiveNodeHttpFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type LiveNodeHttpRegistry = {
  readonly getConnectedNode: (nodeId: string) => NodeConnectionSnapshot | undefined;
};

export type CreateLiveNodeHttpClientBoundaryOptions = {
  readonly registry: LiveNodeHttpRegistry;
  readonly fetch?: LiveNodeHttpFetch;
  readonly timeoutMs?: number;
};

export type LiveNodeHttpClientErrorCode =
  | "NODE_HTTP_INVALID_PATH"
  | "NODE_HTTP_REQUEST_FAILED"
  | "NODE_HTTP_REQUEST_TIMEOUT"
  | "NODE_HTTP_TARGET_STALE";

export class LiveNodeHttpClientError extends Error {
  readonly code: LiveNodeHttpClientErrorCode;
  readonly nodeId: string;
  readonly connectionId: string | undefined;

  constructor(
    code: LiveNodeHttpClientErrorCode,
    message: string,
    options: { nodeId: string; connectionId?: string },
  ) {
    super(message);
    this.name = "LiveNodeHttpClientError";
    this.code = code;
    this.nodeId = options.nodeId;
    this.connectionId = options.connectionId;
  }
}

type LiveNodeHttpSendRequest = {
  readonly nodeId: string;
  readonly connectionId?: string;
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly responseType?: LiveNodeHttpRequest["responseType"];
};

export function createLiveNodeHttpClientBoundary(
  options: CreateLiveNodeHttpClientBoundaryOptions,
): LiveNodeHttpClientBoundary {
  const fetch = options.fetch ?? globalThis.fetch;
  if (typeof fetch !== "function") {
    throw new Error("global fetch is required for live node HTTP client");
  }
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);

  return {
    boardYjsHostHttpClient: createBoardYjsHostHttpClient({
      ...options,
      fetch,
      timeoutMs,
    }),
    requestNode: (request) =>
      requestConnectedNode({ ...options, fetch, timeoutMs }, request),
  };
}

function createBoardYjsHostHttpClient(
  options: Required<CreateLiveNodeHttpClientBoundaryOptions>,
): BoardYjsHostHttpClient {
  return async (request) => {
    assertFreshBoardTarget(options.registry, request.target);
    return sendRequest(options, {
      nodeId: request.target.nodeId,
      connectionId: request.target.connectionId,
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
    });
  };
}

async function requestConnectedNode(
  options: Required<CreateLiveNodeHttpClientBoundaryOptions>,
  request: LiveNodeHttpRequest,
): Promise<LiveNodeHttpResponse> {
  assertAbsolutePath(request);
  const node = options.registry.getConnectedNode(request.nodeId);
  if (node === undefined) {
    throw new LiveNodeHttpClientError(
      "NODE_HTTP_TARGET_STALE",
      `Connected node is no longer available: ${request.nodeId}`,
      { nodeId: request.nodeId },
    );
  }
  return sendRequest(options, {
    nodeId: node.nodeId,
    connectionId: node.connectionId,
    method: request.method,
    url: `http://${node.host}:${node.port}${request.path}`,
    headers: request.headers ?? {},
    body: request.body,
    responseType: request.responseType,
  });
}

async function sendRequest(
  options: Required<CreateLiveNodeHttpClientBoundaryOptions>,
  request: LiveNodeHttpSendRequest,
): Promise<LiveNodeHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetch(request.url, {
      method: request.method,
      headers: headersForRequest(request.headers, request.body),
      body: bodyForRequest(request.body),
      signal: controller.signal,
    });
    return readResponse(response, request.responseType);
  } catch (error) {
    throw mapFetchError(error, request, options.timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

function assertFreshBoardTarget(
  registry: LiveNodeHttpRegistry,
  target: BoardYjsHostTarget,
): void {
  const node = registry.getConnectedNode(target.nodeId);
  if (node?.connectionId === target.connectionId) return;
  throw new LiveNodeHttpClientError(
    "NODE_HTTP_TARGET_STALE",
    `Board Yjs host target is stale: ${target.nodeId}`,
    { nodeId: target.nodeId, connectionId: target.connectionId },
  );
}

function assertAbsolutePath(request: LiveNodeHttpRequest): void {
  if (request.path.startsWith("/")) return;
  throw new LiveNodeHttpClientError(
    "NODE_HTTP_INVALID_PATH",
    `Live node HTTP path must start with '/': ${request.path}`,
    { nodeId: request.nodeId },
  );
}

function headersForRequest(
  input: Readonly<Record<string, string>> | undefined,
  body: unknown,
): Record<string, string> {
  const headers = { ...(input ?? {}) };
  if (body !== undefined && !hasHeader(headers, "content-type")) {
    headers["content-type"] = "application/json";
  }
  return headers;
}

function bodyForRequest(body: unknown): string | undefined {
  return body === undefined ? undefined : JSON.stringify(body);
}

async function readResponse(
  response: Response,
  responseType?: LiveNodeHttpRequest["responseType"],
): Promise<LiveNodeHttpResponse> {
  const headers = responseHeaders(response);
  if (responseType === "arrayBuffer") {
    return {
      statusCode: response.status,
      headers,
      body: Buffer.from(await response.arrayBuffer()),
    };
  }
  const text = await response.text();
  const contentType = headerValue(headers, "content-type");
  return {
    statusCode: response.status,
    headers,
    body:
      contentType?.toLowerCase().includes("application/json") === true
        ? parseJsonBody(text)
        : text,
  };
}

function mapFetchError(
  error: unknown,
  request: LiveNodeHttpSendRequest,
  timeoutMs: number,
): LiveNodeHttpClientError {
  const isTimeout =
    error instanceof Error &&
    (error.name === "AbortError" || error.message.toLowerCase().includes("abort"));
  return new LiveNodeHttpClientError(
    isTimeout ? "NODE_HTTP_REQUEST_TIMEOUT" : "NODE_HTTP_REQUEST_FAILED",
    isTimeout
      ? `Node HTTP request timed out after ${timeoutMs}ms: ${request.method} ${request.url}`
      : `Node HTTP request failed: ${request.method} ${request.url}: ${String(error)}`,
    { nodeId: request.nodeId, connectionId: request.connectionId },
  );
}

function responseHeaders(response: Response): Record<string, string | undefined> {
  return Object.fromEntries(response.headers.entries());
}

function headerValue(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized) return value;
  }
  return undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

function parseJsonBody(text: string): unknown {
  return text.length === 0 ? null : JSON.parse(text);
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? 10_000;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`node HTTP timeoutMs must be a positive integer: ${resolved}`);
  }
  return resolved;
}

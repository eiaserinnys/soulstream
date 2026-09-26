import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { OrchProxyConfig } from "../mcp/runtime.js";

export type HostClientConfig = { orch: OrchProxyConfig; logger: Logger };

export const ORCH_HOST_REQUEST_TIMEOUT_MS = 10_000;
export const ORCH_NODE_COMMAND_TIMEOUT_MS = 35_000;

export interface OrchErrorEnvelope {
  message: string;
  code: string | null;
  details: Record<string, unknown>;
}

export async function fetchOrchResponse(
  orch: Pick<OrchProxyConfig, "baseUrl" | "headers">,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(
    options.timeoutMs ?? ORCH_HOST_REQUEST_TIMEOUT_MS,
  );
  return await (options.fetchImpl ?? fetch)(`${orch.baseUrl}${path}`, {
    method,
    headers: {
      ...orch.headers,
      "content-type": "application/json",
      ...options.headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal]),
  });
}

export async function readOrchErrorEnvelope(
  response: Response,
): Promise<OrchErrorEnvelope> {
  const text = await response.text();
  const fallback = text || `${response.status} ${response.statusText}`;
  if (!text) return { message: fallback, code: null, details: {} };
  try {
    const payload: unknown = JSON.parse(text);
    if (!isRecord(payload)) return { message: fallback, code: null, details: {} };
    const detail = payload.detail;
    if (typeof detail === "string") {
      return { message: detail, code: null, details: {} };
    }
    const envelope = isRecord(detail) ? detail : payload;
    const error = isRecord(envelope.error) ? envelope.error : envelope;
    const details = isRecord(error.details) ? error.details : {};
    return {
      message: typeof error.message === "string" ? error.message : fallback,
      code: typeof error.code === "string" ? error.code : null,
      details,
    };
  } catch {
    return { message: fallback, code: null, details: {} };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REQUEST_ID_HEADER = "x-soulstream-persistence-request-id";
const HOST_RECEIVED_AT_HEADER = "x-soulstream-host-received-at-ms";
const HOST_RESPONDED_AT_HEADER = "x-soulstream-host-responded-at-ms";
const OPAQUE_ARGUMENT_KEYS = new Set(["payload", "caller_info"]);

export class PersistenceHostRequestError extends Error {
  readonly retryable: boolean;
  readonly code: string;

  constructor(
    readonly domain: string,
    readonly operation: string,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown; code?: string },
  ) {
    super(message, options);
    this.name = "PersistenceHostRequestError";
    this.code = options?.code ?? "HOST_OPERATION_FAILED";
    this.retryable = status === undefined || status === 408 || status === 429 || status >= 500;
  }
}

export class PersistenceHostTransport {
  constructor(private readonly config: HostClientConfig) {}

  async send(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      headers?: Record<string, string>;
      fetchImpl?: typeof fetch;
    } = {},
  ): Promise<Response> {
    return await fetchOrchResponse(this.config.orch, method, path, body, options);
  }

  async request<T>(
    domain: string,
    operation: string,
    args: unknown[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const requestId = randomUUID();
    const nodeRequestedAtMs = Date.now();
    let response: Response | undefined;
    let responseBody: string;
    try {
      response = await this.send(
        "POST",
        `/api/${domain}/host/${encodeURIComponent(operation)}`,
        { args: snakeCase(args) },
        {
          ...options,
          headers: { [REQUEST_ID_HEADER]: requestId },
        },
      );
      responseBody = await response.text();
    } catch (error) {
      const nodeRequestFailedAtMs = Date.now();
      const hostTiming = response ? readHostTiming(response) : undefined;
      this.config.logger.warn(
        {
          requestId,
          domain,
          operation,
          nodeRequestedAtMs,
          nodeRequestFailedAtMs,
          totalDurationMs: nodeRequestFailedAtMs - nodeRequestedAtMs,
          ...(response ? { status: response.status, ...hostTiming } : {}),
          err: error,
        },
        response
          ? "persistence host response read failed"
          : "persistence host request failed before response",
      );
      throw new PersistenceHostRequestError(
        domain,
        operation,
        `${domain} host ${operation} request failed`,
        undefined,
        { cause: error },
      );
    }
    const nodeResponseReadAtMs = Date.now();
    const hostTiming = readHostTiming(response);
    const timing = {
      requestId,
      domain,
      operation,
      status: response.status,
      nodeRequestedAtMs,
      ...hostTiming,
      nodeResponseReadAtMs,
      requestToHostMs: subtract(hostTiming.hostReceivedAtMs, nodeRequestedAtMs),
      hostProcessingMs: subtract(hostTiming.hostRespondedAtMs, hostTiming.hostReceivedAtMs),
      hostToResponseReadMs: subtract(nodeResponseReadAtMs, hostTiming.hostRespondedAtMs),
      totalDurationMs: nodeResponseReadAtMs - nodeRequestedAtMs,
    };
    if (!response.ok) {
      const hostError = parseHostError(responseBody);
      this.config.logger.warn(
        { ...timing, message: responseBody },
        "persistence host request failed",
      );
      throw new PersistenceHostRequestError(
        domain,
        operation,
        `${domain} host ${operation} failed: ${(hostError?.message ?? responseBody) || response.statusText}`,
        response.status,
        { code: hostError?.code },
      );
    }
    this.config.logger.info(timing, "persistence host request completed");
    return reviveDates(JSON.parse(responseBody)) as T;
  }
}

function parseHostError(body: string): { code: string; message: string } | undefined {
  try {
    const parsed = JSON.parse(body) as {
      detail?: { error?: { code?: unknown; message?: unknown } };
    };
    const error = parsed.detail?.error;
    if (typeof error?.code !== "string" || typeof error.message !== "string") return undefined;
    return { code: error.code, message: error.message };
  } catch {
    return undefined;
  }
}

function readHostTiming(response: Response): {
  hostReceivedAtMs: number | null;
  hostRespondedAtMs: number | null;
} {
  return {
    hostReceivedAtMs: epochMsHeader(response, HOST_RECEIVED_AT_HEADER),
    hostRespondedAtMs: epochMsHeader(response, HOST_RESPONDED_AT_HEADER),
  };
}

function epochMsHeader(response: Response, name: string): number | null {
  const value = response.headers.get(name);
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function subtract(later: number | null, earlier: number | null): number | null {
  return later === null || earlier === null ? null : later - earlier;
}

function snakeCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeCase);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .map(([key, child]) => {
      const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      return [
        snakeKey,
        OPAQUE_ARGUMENT_KEYS.has(snakeKey) ? child : snakeCase(child),
      ];
    }));
}

function reviveDates(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map(child => reviveDates(child));
  if (typeof value === "string" && key !== "daily_date" && /(?:_at|At|_before|Before|_expires_at)$/.test(key ?? "")) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : value;
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([childKey, child]) => [childKey, reviveDates(child, childKey)]));
}

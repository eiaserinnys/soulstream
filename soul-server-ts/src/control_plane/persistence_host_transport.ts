import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { OrchProxyConfig } from "../mcp/runtime.js";

export type HostClientConfig = { orch: OrchProxyConfig; logger: Logger };

const REQUEST_ID_HEADER = "x-soulstream-persistence-request-id";
const HOST_RECEIVED_AT_HEADER = "x-soulstream-host-received-at-ms";
const HOST_RESPONDED_AT_HEADER = "x-soulstream-host-responded-at-ms";
const OPAQUE_ARGUMENT_KEYS = new Set(["payload"]);

export class PersistenceHostRequestError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly domain: string,
    readonly operation: string,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PersistenceHostRequestError";
    this.retryable = status === undefined || status === 408 || status === 429 || status >= 500;
  }
}

export class PersistenceHostTransport {
  constructor(private readonly config: HostClientConfig) {}

  async request<T>(
    domain: string,
    operation: string,
    args: unknown[],
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const requestId = randomUUID();
    const nodeRequestedAtMs = Date.now();
    let response: Response | undefined;
    let responseBody: string;
    try {
      response = await fetch(
        `${this.config.orch.baseUrl}/api/${domain}/host/${encodeURIComponent(operation)}`,
        {
          method: "POST",
          headers: {
            ...this.config.orch.headers,
            "content-type": "application/json",
            [REQUEST_ID_HEADER]: requestId,
          },
          body: JSON.stringify({ args: snakeCase(args) }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
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
      this.config.logger.warn(
        { ...timing, message: responseBody },
        "persistence host request failed",
      );
      throw new PersistenceHostRequestError(
        domain,
        operation,
        `${domain} host ${operation} failed: ${responseBody || response.statusText}`,
        response.status,
      );
    }
    this.config.logger.info(timing, "persistence host request completed");
    return reviveDates(JSON.parse(responseBody)) as T;
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

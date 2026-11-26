import { readOrchErrorEnvelopeText, type OrchErrorEnvelope } from "@soulstream/mcp-contract";
import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { OrchProxyConfig } from "../mcp/runtime.js";

export type HostClientConfig = { orch: OrchProxyConfig; logger: Logger };

export const ORCH_HOST_REQUEST_TIMEOUT_MS = 10_000;
const SLOW_HOST_REQUEST_MS = 1_000;

export async function fetchOrchResponse(
  orch: Pick<OrchProxyConfig, "baseUrl" | "headers">,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    fetchImpl?: typeof fetch;
    serializedBody?: string;
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
    ...(body !== undefined ? { body: options.serializedBody ?? JSON.stringify(body) } : {}),
    signal: options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal]),
  });
}

export async function readOrchErrorEnvelope(response: Response): Promise<OrchErrorEnvelope> {
  return readOrchErrorEnvelopeText(response, await response.text());
}

const REQUEST_ID_HEADER = "x-soulstream-persistence-request-id";
const HOST_RECEIVED_AT_HEADER = "x-soulstream-host-received-at-ms";
const HOST_RESPONDED_AT_HEADER = "x-soulstream-host-responded-at-ms";
const OPAQUE_ARGUMENT_KEYS = new Set(["payload", "caller_info"]);
/** Response keys whose subtree is persisted JSON and is returned exactly as stored. */
const OPAQUE_RESPONSE_KEYS = new Set(["metadata", "persistent_report"]);

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

export type HostFailureKind = "restart-window" | "transient" | "fatal";

/** HTTP answers that mean the peer has not finished (re)starting yet. */
const RESTART_WINDOW_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

const CONNECTION_LOST_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

interface FailureCause {
  name?: unknown;
  code?: unknown;
  message?: unknown;
}

function failureCauses(error: unknown): FailureCause[] {
  const causes: FailureCause[] = [];
  let current: unknown = (error as { cause?: unknown } | null | undefined)?.cause;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const cause = current as FailureCause;
    causes.push(cause);
    current = (cause as { cause?: unknown }).cause;
  }
  return causes;
}

function isTimeoutCause(cause: FailureCause): boolean {
  if (cause.name === "TimeoutError") return true;
  if (typeof cause.code === "string" && TIMEOUT_CODES.has(cause.code)) return true;
  return typeof cause.message === "string" && /timed? ?out/i.test(cause.message);
}

function isConnectionLostCause(cause: FailureCause): boolean {
  if (typeof cause.code === "string" && CONNECTION_LOST_CODES.has(cause.code)) return true;
  return typeof cause.message === "string"
    && /socket hang up|other side closed|ECONNREFUSED|ECONNRESET/i.test(cause.message);
}

/**
 * A failure where the peer answered (or refused) but is not up yet: connection
 * refused/lost, 502, 503, 504. Timeouts, 408 and 429 read as a busy host and
 * keep the plain attempt budget; 4xx and non-host errors are fatal.
 */
export function classifyHostFailure(error: unknown): HostFailureKind {
  if (!(error instanceof PersistenceHostRequestError) || !error.retryable) return "fatal";
  if (error.status !== undefined) {
    return RESTART_WINDOW_STATUSES.has(error.status) ? "restart-window" : "transient";
  }
  const causes = failureCauses(error);
  if (causes.some(isTimeoutCause)) return "transient";
  if (causes.some(isConnectionLostCause)) return "restart-window";
  return "transient";
}

/** Short label for the retry log: `http-502`, `timeout`, `network-ECONNREFUSED`. */
export function describeHostFailure(error: unknown): string {
  if (!(error instanceof PersistenceHostRequestError)) return "error";
  if (error.status !== undefined) return `http-${error.status}`;
  const causes = failureCauses(error);
  if (causes.some(isTimeoutCause)) return "timeout";
  const code = causes
    .map(cause => cause.code)
    .find((value): value is string => typeof value === "string");
  return code === undefined ? "network-error" : `network-${code}`;
}

export interface RestartWindowRetryEvent {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  failure: string;
  /** Milliseconds since the first attempt started. */
  elapsedMs: number;
  /** Delay before the next attempt, already clamped to the budget. */
  retryInMs: number;
}

export interface RestartWindowRecoveryEvent {
  /** 1-based number of the attempt that succeeded. */
  attempt: number;
  elapsedMs: number;
}

/**
 * Widening retry policy for a read that must outlast an orchestrator restart.
 * Only restart-window failures draw on `totalBudgetMs`; timeouts and other
 * transient failures keep the plain attempt×timeout schedule. The last attempt
 * starts inside the budget with its timeout reduced to the time that remains.
 */
export interface RestartWindowRetryPolicy {
  /** Whole-call budget counted from the first attempt. */
  totalBudgetMs: number;
  /**
   * Timeout of every attempt under this policy. A slow host must cost latency,
   * not the session start, so it replaces the caller's plain timeout. The retry
   * loop still reduces it to the time left in the budget before the last
   * attempt.
   */
  attemptTimeoutMs?: number;
  /** Delays before restart-window retries; the last value repeats. */
  retryDelaysMs: readonly number[];
  onRetry?: (event: RestartWindowRetryEvent) => void;
  onRecovered?: (event: RestartWindowRecoveryEvent) => void;
}

/**
 * Schedule shared by the three central reads a session start cannot do
 * without (card #1350): caller_chain, the evicted-session read, and the
 * isolation worktree inventory. A restart between SIGTERM and listening took a
 * median ~16s and p90 ~52s in the 48h sample of card #1380, so each attempt
 * gets 8s and the whole call may take 90s; a five-minute central outage (338s)
 * still fails the start.
 */
export const SESSION_START_RESTART_WINDOW: RestartWindowRetryPolicy = {
  totalBudgetMs: 90_000,
  attemptTimeoutMs: 8_000,
  retryDelaysMs: [250, 1_000, 2_000, 4_000],
};

/**
 * Global setTimeout keeps the retry schedule drivable by fake timers in tests;
 * node:timers/promises bypasses them. Production behavior is the same.
 */
function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, delayMs); });
}

export async function requestHostOperationWithRetry<T>(
  transport: Pick<PersistenceHostTransport, "request">,
  domain: string,
  operation: string,
  args: unknown[],
  options: {
    timeoutMs: number;
    attempts: number;
    signal?: AbortSignal;
    retryDelaysMs?: readonly number[];
    restartWindow?: RestartWindowRetryPolicy;
    /** Argument keys the host persists verbatim; every attempt keeps them as-is. */
    opaqueArgumentKeys?: readonly string[];
  },
): Promise<T> {
  const startedAtMs = Date.now();
  const restartWindow = options.restartWindow;
  const restartDeadlineMs = restartWindow === undefined
    ? Number.POSITIVE_INFINITY
    : startedAtMs + restartWindow.totalBudgetMs;
  let lastError: unknown = undefined;
  let attempt = 0;
  let transientFailures = 0;
  let restartFailures = 0;
  const attemptBudgetMs = restartWindow?.attemptTimeoutMs ?? options.timeoutMs;
  let attemptTimeoutMs = attemptBudgetMs;
  for (;;) {
    attempt += 1;
    try {
      const result = await transport.request<T>(domain, operation, args, {
        timeoutMs: attemptTimeoutMs,
        signal: options.signal,
        ...(options.opaqueArgumentKeys === undefined
          ? {}
          : { opaqueArgumentKeys: options.opaqueArgumentKeys }),
      });
      if (restartWindow !== undefined && attempt > 1) {
        restartWindow.onRecovered?.({
          attempt,
          elapsedMs: Date.now() - startedAtMs,
        });
      }
      return result;
    } catch (error) {
      lastError = error;
      const kind = classifyHostFailure(error);
      if (options.signal?.aborted || kind === "fatal") break;
      if (kind === "restart-window" && restartWindow !== undefined) {
        restartFailures += 1;
        const remainingMs = restartDeadlineMs - Date.now();
        if (remainingMs <= 1) break;
        const delays = restartWindow.retryDelaysMs;
        const widenedDelayMs = delays.length === 0
          ? 0
          : (delays[Math.min(restartFailures - 1, delays.length - 1)] ?? 0);
        const delayMs = Math.min(widenedDelayMs, remainingMs - 1);
        restartWindow.onRetry?.({
          attempt,
          failure: describeHostFailure(error),
          elapsedMs: Date.now() - startedAtMs,
          retryInMs: delayMs,
        });
        if (delayMs > 0) await sleep(delayMs);
        const remainingAfterDelayMs = restartDeadlineMs - Date.now();
        if (remainingAfterDelayMs <= 0) break;
        attemptTimeoutMs = Math.min(attemptBudgetMs, remainingAfterDelayMs);
        continue;
      }
      transientFailures += 1;
      if (transientFailures >= options.attempts) break;
      const delayMs = options.retryDelaysMs?.[transientFailures - 1] ?? 0;
      restartWindow?.onRetry?.({
        attempt,
        failure: describeHostFailure(error),
        elapsedMs: Date.now() - startedAtMs,
        retryInMs: delayMs,
      });
      if (delayMs > 0) await sleep(delayMs);
      attemptTimeoutMs = attemptBudgetMs;
    }
  }
  throw lastError;
}

export class PersistenceHostTransport {
  constructor(private readonly config: HostClientConfig) {}

  async send(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      headers?: Record<string, string>;
      fetchImpl?: typeof fetch;
      serializedBody?: string;
    } = {},
  ): Promise<Response> {
    return await fetchOrchResponse(this.config.orch, method, path, body, options);
  }

  async request<T>(
    domain: string,
    operation: string,
    args: unknown[],
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      opaqueArgumentIndexes?: readonly number[];
      opaqueArgumentKeys?: readonly string[];
    } = {},
  ): Promise<T> {
    const { opaqueArgumentIndexes = [], opaqueArgumentKeys = [], ...requestOptions } = options;
    const opaqueIndexes = new Set(opaqueArgumentIndexes);
    const opaqueKeys = opaqueArgumentKeys.length === 0
      ? OPAQUE_ARGUMENT_KEYS
      : new Set([...OPAQUE_ARGUMENT_KEYS, ...opaqueArgumentKeys]);
    const requestId = randomUUID();
    const nodeRequestedAtMs = Date.now();
    let response: Response | undefined;
    let responseBody: string;
    let requestBody = "";
    try {
      const body = {
        args: args.map((argument, index) => opaqueIndexes.has(index)
          ? argument
          : snakeCase(argument, opaqueKeys)),
      };
      requestBody = JSON.stringify(body);
      response = await this.send(
        "POST",
        `/api/${domain}/host/${encodeURIComponent(operation)}`,
        body,
        {
          ...requestOptions,
          headers: { [REQUEST_ID_HEADER]: requestId },
          serializedBody: requestBody,
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
      const sessionId = args.map((arg) => {
        if (typeof arg !== "object" || arg === null) return undefined;
        const input = arg as Record<string, unknown>;
        const value = input.sessionId ?? input.session_id;
        return typeof value === "string" ? value : undefined;
      }).find((value) => value !== undefined);
      this.config.logger.warn(
        { ...timing, requestBodyBytes: Buffer.byteLength(requestBody, "utf8"), ...(sessionId ? { sessionId } : {}), message: responseBody },
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
    const level = timing.totalDurationMs >= SLOW_HOST_REQUEST_MS ? "info" : "debug";
    this.config.logger[level](timing, "persistence host request completed");
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

function snakeCase(value: unknown, opaqueKeys: ReadonlySet<string> = OPAQUE_ARGUMENT_KEYS): unknown {
  if (Array.isArray(value)) return value.map(child => snakeCase(child, opaqueKeys));
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .map(([key, child]) => {
      const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      return [
        snakeKey,
        opaqueKeys.has(snakeKey) ? child : snakeCase(child, opaqueKeys),
      ];
    }));
}

function reviveDates(value: unknown, key?: string): unknown {
  // `sessions.metadata` is persisted JSON, not row columns. Its readers
  // (task hydration, the metadata extractors) take timestamps as the strings
  // they were written as, so reviving them drops entries such as a pending
  // generation request whose `requested_at` is required to be a string.
  if (key !== undefined && OPAQUE_RESPONSE_KEYS.has(key)) return value;
  if (Array.isArray(value)) return value.map(child => reviveDates(child));
  if (typeof value === "string" && key !== "daily_date" && /(?:_at|At|_before|Before|_expires_at)$/.test(key ?? "")) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : value;
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([childKey, child]) => [childKey, reviveDates(child, childKey)]));
}

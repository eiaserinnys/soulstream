import type { Logger } from "pino";

// Must remain below the orch provider usage command timeout (15 seconds), or the
// node response will be discarded before it can cross the upstream boundary.
export const PROVIDER_USAGE_REQUEST_TIMEOUT_MS = 14_000;
export const PROVIDER_USAGE_SLOW_REQUEST_THRESHOLD_MS = 5_000;

export type ProviderUsageLogger = Pick<Logger, "debug" | "info" | "warn">;
export type ProviderUsageProvider = "claude" | "codex" | "gemini";

export interface ProviderUsageAttempt {
  endpoint: string;
  durationMs: number;
  result: string;
  status?: number | string;
  budgetMs?: number;
  [key: string]: unknown;
}

interface ProviderUsageLogFields {
  provider: ProviderUsageProvider;
  endpoint: string;
  durationMs: number;
  result: string;
  [key: string]: unknown;
}

export function providerUsageEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "invalid-endpoint";
  }
}

export function providerUsageDurationMs(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

export function providerUsageStarted(
  logger: ProviderUsageLogger | undefined,
  provider: ProviderUsageProvider,
  endpoint: string,
): void {
  logger?.info({ provider, endpoint, durationMs: 0, result: "started" }, "Provider usage request started");
}

export function providerUsageFinished(
  logger: ProviderUsageLogger | undefined,
  fields: ProviderUsageLogFields,
  slowRequestThresholdMs = PROVIDER_USAGE_SLOW_REQUEST_THRESHOLD_MS,
): void {
  const message = "Provider usage request finished";
  if (
    fields.result === "error" ||
    fields.result === "http_error" ||
    fields.result === "cloudflare_challenge" ||
    fields.result === "timeout" ||
    fields.durationMs >= slowRequestThresholdMs
  ) {
    logger?.warn(fields, message);
    return;
  }
  logger?.info(fields, message);
}

export function providerUsageSummary(
  logger: ProviderUsageLogger | undefined,
  fields: ProviderUsageLogFields & {
    attempts: ProviderUsageAttempt[];
    status?: string;
  },
  slowRequestThresholdMs = PROVIDER_USAGE_SLOW_REQUEST_THRESHOLD_MS,
): void {
  if (
    (fields.result === "success" || fields.result === "not_configured")
    && fields.durationMs < slowRequestThresholdMs
  ) {
    logger?.info(fields, "Provider usage summary");
    return;
  }
  logger?.warn(fields, "Provider usage summary");
}

export interface ProviderUsageDeadline {
  signal: AbortSignal;
  scheduledAbortAtMs: number;
  cancel(): void;
}

export function createProviderUsageDeadline(
  logger: ProviderUsageLogger | undefined,
  fields: {
    provider: ProviderUsageProvider;
    endpoint: string;
    timeoutMs: number;
    scope: "provider" | "candidate";
  },
): ProviderUsageDeadline {
  const controller = new AbortController();
  const scheduledAbortAtMs = Date.now() + fields.timeoutMs;
  const timer = setTimeout(() => {
    const actualAbortAtMs = Date.now();
    logger?.warn(
      {
        provider: fields.provider,
        endpoint: fields.endpoint,
        durationMs: Math.max(0, actualAbortAtMs - (scheduledAbortAtMs - fields.timeoutMs)),
        result: "timeout_fired",
        timeoutScope: fields.scope,
        timeoutMs: fields.timeoutMs,
        scheduledAbortAtMs,
        actualAbortAtMs,
        abortDelayMs: Math.max(0, actualAbortAtMs - scheduledAbortAtMs),
      },
      "Provider usage timeout fired",
    );
    controller.abort(new DOMException("Provider usage request timed out", "TimeoutError"));
  }, fields.timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    scheduledAbortAtMs,
    cancel: () => clearTimeout(timer),
  };
}

export function providerUsageFailureResult(signal: AbortSignal, error: unknown): "timeout" | "error" {
  if (signal.aborted) return "timeout";
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  return "error";
}

export function withinProviderUsageTimeout<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("Provider usage request aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Provider usage request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

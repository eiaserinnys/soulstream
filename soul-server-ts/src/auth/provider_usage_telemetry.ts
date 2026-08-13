import type { Logger } from "pino";

// Must remain below the orch provider usage command timeout (15 seconds), or the
// node response will be discarded before it can cross the upstream boundary.
export const PROVIDER_USAGE_REQUEST_TIMEOUT_MS = 10_000;
export const PROVIDER_USAGE_SLOW_REQUEST_THRESHOLD_MS = 5_000;

export type ProviderUsageLogger = Pick<Logger, "debug" | "warn">;
export type ProviderUsageProvider = "claude" | "codex" | "gemini";

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
  logger?.debug({ provider, endpoint, durationMs: 0, result: "started" }, "Provider usage request started");
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
    fields.result === "timeout" ||
    fields.durationMs >= slowRequestThresholdMs
  ) {
    logger?.warn(fields, message);
    return;
  }
  logger?.debug(fields, message);
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

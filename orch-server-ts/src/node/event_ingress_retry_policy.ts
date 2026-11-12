import type { EventIngressFailureDetail } from "./event_ingress_dead_letter_store.js";
import type { EventIngressResult } from "./event_ingress_types.js";

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;

const TRANSIENT_SQLSTATE_CODES = new Set([
  "40P01", // deadlock_detected
  "40001", // serialization_failure
  "55P03", // lock_not_available
  "57014", // query_canceled
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);
// SQLSTATE class 08: connection_exception, e.g. 08000, 08003, 08006, 08P01.
const TRANSIENT_SQLSTATE_CLASS_PATTERN = /^08[0-9A-Z]{3}$/;
const TRANSIENT_CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
]);
const TRANSIENT_CONNECTION_MESSAGE_PATTERN = /Connection terminated/i;

type HealthProbeSql = {
  (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<readonly Record<string, unknown>[]>;
};

export type EventIngressRetryPolicyOptions = {
  failureThreshold?: number;
  retryDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
};

export type EventIngressFailureClass = "transient" | "event";

/**
 * Transient failures belong to the database connection or its concurrency
 * control, not to the envelope, so they never advance an event's poison count.
 * Everything else is an event failure and keeps the five-attempt budget.
 */
export function classifyEventIngressFailure(
  error: unknown,
): EventIngressFailureClass {
  const candidate =
    error && typeof error === "object"
      ? (error as { code?: unknown; message?: unknown })
      : undefined;
  const rawCode = candidate?.code;
  const code =
    typeof rawCode === "string" || typeof rawCode === "number"
      ? String(rawCode)
      : undefined;
  if (
    code !== undefined
    && (
      TRANSIENT_SQLSTATE_CODES.has(code)
      || TRANSIENT_SQLSTATE_CLASS_PATTERN.test(code)
      || TRANSIENT_CONNECTION_CODES.has(code)
    )
  ) {
    return "transient";
  }
  return candidate && typeof candidate.message === "string"
    && TRANSIENT_CONNECTION_MESSAGE_PATTERN.test(candidate.message)
    ? "transient"
    : "event";
}

export class EventIngressRetryPolicy {
  readonly failureThreshold: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(options: EventIngressRetryPolicyOptions = {}) {
    this.failureThreshold =
      options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.sleep = options.sleep ?? wait;
    if (
      !Number.isSafeInteger(this.failureThreshold) ||
      this.failureThreshold <= 1
    ) {
      throw new Error(
        "event ingress failure threshold must be an integer greater than one",
      );
    }
    if (
      this.retryDelaysMs.length !== this.failureThreshold - 1 ||
      this.retryDelaysMs.some(
        (delayMs) => !Number.isFinite(delayMs) || delayMs < 0,
      )
    ) {
      throw new Error(
        "event ingress retry delays must define one non-negative delay per retry",
      );
    }
  }

  async assertDatabaseReachable(
    sql: HealthProbeSql,
    eventError: unknown,
  ): Promise<void> {
    try {
      await sql`SELECT 1 AS event_ingress_health`;
    } catch {
      // If even an independent probe cannot complete, the failure belongs to the
      // infrastructure rather than this envelope. Do not advance its poison count.
      throw eventError;
    }
  }

  failureDetail(error: unknown): EventIngressFailureDetail {
    const candidate =
      error && typeof error === "object"
        ? (error as { name?: unknown; message?: unknown; code?: unknown })
        : undefined;
    const reason =
      candidate && typeof candidate.message === "string"
        ? candidate.message
        : String(error);
    const code = candidate?.code;
    return {
      reason: reason.slice(0, 4_096),
      errorName:
        candidate && typeof candidate.name === "string"
          ? candidate.name
          : "UnknownError",
      ...(typeof code === "string" || typeof code === "number"
        ? { errorCode: String(code) }
        : {}),
    };
  }

  /** `attemptCounts` are one-based retry stages; the last delay repeats. */
  async waitForRetry(attemptCounts: readonly number[]): Promise<void> {
    const delayMs = Math.max(
      ...attemptCounts.map(
        (count) =>
          this.retryDelaysMs[
            Math.min(count - 1, this.retryDelaysMs.length - 1)
          ]!,
      ),
    );
    await this.sleep(delayMs);
  }
}

export function completedIngressResults(
  results: Array<EventIngressResult | undefined>,
): EventIngressResult[] {
  if (results.some((result) => result === undefined)) {
    throw new Error(
      "event ingress batch finished without a result for every envelope",
    );
  }
  return results as EventIngressResult[];
}

async function wait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

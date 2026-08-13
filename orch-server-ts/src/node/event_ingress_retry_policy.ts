import type { EventIngressFailureDetail } from "./event_ingress_dead_letter_store.js";
import type { EventIngressResult } from "./event_ingress_types.js";

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;

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

  async waitForRetry(failureCounts: readonly number[]): Promise<void> {
    const delayMs = Math.max(
      ...failureCounts.map(
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

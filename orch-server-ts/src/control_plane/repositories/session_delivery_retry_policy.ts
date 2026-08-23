import type { SessionDeliveryRow, SqlClient } from "../control_plane_types.js";
import type { SessionDeliveryAttemptOutcome } from
  "./session_delivery_attempt_repository.js";

/**
 * Retry budget for `session_deliveries`.
 *
 * Mirrors `soul-server-ts/src/task/session_delivery_notification_policy.ts` so
 * the aggregate and its notification projection give up on the same terms.
 */
export const DELIVERY_MAX_ATTEMPTS = 16;
export const DELIVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface DeliveryRetryOrParkInput {
  reason: string;
  /** State to return to while the delivery still has budget. */
  retryState: "pending" | "queued";
  /**
   * Delay before the next attempt. Omit to use the canonical backoff ladder.
   *
   * This is a duration, never an absolute instant: the caller's clock is not
   * the database's, and a node-computed timestamp compared against `NOW()`
   * either nullified the backoff or doubled it depending on skew direction
   * (7.45s measured between the WSL node and the host).
   */
  retryDelayMs?: number;
  /**
   * Keep an error already recorded on the row instead of overwriting it. Used
   * by the lease sweeper, whose own reason ("lease expired") is less useful
   * than whatever the previous owner recorded before it died.
   */
  preserveExistingError?: boolean;
  /**
   * Whether this counts as a delivery attempt. Default true.
   *
   * A liveness probe — "is the transcript settled yet?" — is not an attempt to
   * deliver anything, and it repeats on a one-second cadence. Charging it to
   * the same 16-attempt budget would dead-letter a perfectly good user message
   * about eighty seconds after its target node went quiet, which is the exact
   * loss this budget exists to prevent. A probe spends time, not budget: only
   * the age ceiling can end it.
   */
  spendsAttempt?: boolean;
  maxAttempts?: number;
  maxAgeMs?: number;
}

/**
 * Canonical "spend one attempt, or park until a newer execution" SET clause.
 *
 * Every retry path used to schedule the next attempt without ever consulting a
 * budget, so a delivery whose target never became dispatchable retried forever
 * — the 260820 incident left three user messages at 1,932 / 155 / 154 attempts
 * with no terminal state. Routing every one of those paths through this clause
 * makes "attempt again" and "dead-letter" a single decision with a single
 * definition, evaluated entirely on the database clock. Exhaustion is a
 * liveness backstop, not a deletion policy: the row stays aggregate-pending
 * and a newer active execution generation may recover it.
 */
export function deliveryRetryOrParkSet(
  sql: SqlClient,
  input: DeliveryRetryOrParkInput,
) {
  const maxAttempts = input.maxAttempts ?? DELIVERY_MAX_ATTEMPTS;
  const maxAgeMs = input.maxAgeMs ?? DELIVERY_MAX_AGE_MS;
  const spendsAttempt = input.spendsAttempt ?? true;
  const reason = input.preserveExistingError
    ? sql`COALESCE(last_error, ${input.reason})`
    : sql`${input.reason}`;
  const retryDelay = input.retryDelayMs === undefined
    ? sql`LEAST(
        INTERVAL '60 seconds',
        INTERVAL '100 milliseconds' * POWER(2, LEAST(attempt_count, 9))
      )`
    : sql`(${input.retryDelayMs}::double precision * INTERVAL '1 millisecond')`;
  const tooOld = sql`created_at <= NOW() - (${maxAgeMs}::double precision * INTERVAL '1 millisecond')`;
  const exhausted = spendsAttempt
    ? sql`(attempt_count + 1 >= ${maxAttempts} OR ${tooOld})`
    : sql`(${tooOld})`;
  return sql`
    attempt_count = attempt_count + ${spendsAttempt ? 1 : 0},
    state = CASE WHEN ${exhausted} THEN 'uncertain' ELSE ${input.retryState} END,
    aggregate_state = 'pending',
    lease_owner = NULL,
    lease_expires_at = NULL,
    next_attempt_at = CASE
      WHEN ${exhausted} THEN NOW() + INTERVAL '60 seconds'
      ELSE NOW() + ${retryDelay}
    END,
    last_error = ${reason},
    dead_letter_reason = NULL,
    dead_lettered_at = NULL,
    updated_at = NOW()
  `;
}

/** An exhausted delivery is a rejected attempt; anything else is retryable. */
export function attemptOutcomeFor(
  row: Pick<SessionDeliveryRow, "aggregate_state">,
): SessionDeliveryAttemptOutcome {
  return row.aggregate_state === "dead_letter" ? "rejected" : "retryable";
}

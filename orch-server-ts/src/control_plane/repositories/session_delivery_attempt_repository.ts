import type { SqlClient } from "../control_plane_types.js";

export type SessionDeliveryAttemptOutcome = "accepted" | "retryable" | "rejected";

/** Appends one immutable admission verdict while the caller holds the delivery row lock. */
export async function appendSessionDeliveryAttempt(
  sql: SqlClient,
  input: {
    deliveryId: string;
    outcome: SessionDeliveryAttemptOutcome;
    reason: string;
    leaseOwner?: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO session_delivery_attempts (
      delivery_id, attempt_number, lease_owner, payload_hash, outcome, reason
    )
    SELECT delivery.delivery_id,
      COALESCE((
        SELECT MAX(attempt.attempt_number) + 1
        FROM session_delivery_attempts AS attempt
        WHERE attempt.delivery_id = delivery.delivery_id
      ), 1),
      COALESCE(${input.leaseOwner ?? null}, delivery.lease_owner),
      delivery.payload_hash,
      ${input.outcome},
      ${input.reason}
    FROM session_deliveries AS delivery
    WHERE delivery.delivery_id = ${input.deliveryId}
  `;
}

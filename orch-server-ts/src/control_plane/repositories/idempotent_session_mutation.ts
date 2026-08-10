import { createHash } from "node:crypto";

import type { SqlClient } from "../control_plane_types.js";

type MutationReceipt = {
  operation: string;
  session_id: string;
  request_hash: string;
  result_json: unknown;
};

/** Commits a session-owned mutation and its replay receipt in one transaction. */
export async function runIdempotentSessionMutation<T>(
  sql: SqlClient,
  operation: string,
  input: { idempotencyKey: string; sessionId: string },
  mutate: (transaction: SqlClient) => Promise<T>,
): Promise<T> {
  if (!input.idempotencyKey) throw hostError(422, "idempotencyKey is required");
  // Transport retries may reconstruct operational timestamps. The key owns the
  // original committed time; semantic fields must still match exactly.
  const requestHash = createHash("sha256")
    .update(JSON.stringify(input, (key, value) =>
      key === "createdAt" || key === "updatedAt" || key === "observedAt"
        ? undefined
        : value))
    .digest("hex");
  const result = await sql.begin(async (transaction) => {
    const tx = transaction as unknown as SqlClient;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))`;
    const receipts = await tx<MutationReceipt[]>`
      SELECT operation, session_id, request_hash, result_json
      FROM session_mutation_receipts
      WHERE idempotency_key = ${input.idempotencyKey}
      FOR UPDATE
    `;
    const receipt = receipts[0];
    if (receipt) {
      if (
        receipt.operation !== operation
        || receipt.session_id !== input.sessionId
        || receipt.request_hash !== requestHash
      ) {
        throw hostError(409, `idempotency key conflict: ${input.idempotencyKey}`);
      }
      return receipt.result_json as T;
    }
    const applied = await mutate(tx);
    await tx`
      INSERT INTO session_mutation_receipts (
        idempotency_key, operation, session_id, request_hash, result_json
      ) VALUES (
        ${input.idempotencyKey}, ${operation}, ${input.sessionId}, ${requestHash},
        ${tx.json(applied as never)}
      )
    `;
    return applied;
  });
  return result as T;
}

function hostError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

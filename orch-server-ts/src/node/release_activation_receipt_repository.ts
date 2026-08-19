import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";

export interface ReleaseActivationPersistInput {
  nodeId: string;
  manifestId: string;
  releaseCohortId: string;
  sourceCommit: string;
  prewarmedAt: string;
  verification: {
    host: "verified";
    runner: "verified";
    env: "verified";
    executable: "verified";
  };
  registrationIdempotencyKey: string;
}

export interface ReleaseActivationReceiptRecord {
  manifest_id: string;
  activation_generation: number;
  activated_at: string;
  registration_idempotency_key: string;
}

export interface ReleaseActivationReceiptStore {
  persist(input: ReleaseActivationPersistInput): Promise<ReleaseActivationReceiptRecord>;
}

type ReceiptRow = {
  manifest_id: unknown;
  activation_generation: unknown;
  activated_at: unknown;
  registration_idempotency_key: unknown;
};

export class ReleaseActivationReceiptRepository implements ReleaseActivationReceiptStore {
  constructor(private readonly sqlResolver: LiveDbSqlResolver) {}

  async persist(input: ReleaseActivationPersistInput): Promise<ReleaseActivationReceiptRecord> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<ReceiptRow[]>`
      INSERT INTO node_release_activation_receipts (
        node_id,
        manifest_id,
        release_cohort_id,
        source_commit,
        prewarmed_at,
        verification,
        registration_idempotency_key
      ) VALUES (
        ${input.nodeId},
        ${input.manifestId},
        ${input.releaseCohortId},
        ${input.sourceCommit},
        ${new Date(input.prewarmedAt)},
        ${sql.json(input.verification)},
        ${input.registrationIdempotencyKey}
      )
      ON CONFLICT (node_id, registration_idempotency_key)
      DO UPDATE SET registration_idempotency_key = EXCLUDED.registration_idempotency_key
      WHERE node_release_activation_receipts.manifest_id = EXCLUDED.manifest_id
        AND node_release_activation_receipts.release_cohort_id = EXCLUDED.release_cohort_id
        AND node_release_activation_receipts.source_commit = EXCLUDED.source_commit
        AND node_release_activation_receipts.prewarmed_at = EXCLUDED.prewarmed_at
        AND node_release_activation_receipts.verification = EXCLUDED.verification
      RETURNING manifest_id, activation_generation, activated_at,
                registration_idempotency_key
    `;
    const row = rows[0];
    if (!row) throw new Error("release activation idempotency conflict");
    const generation = Number(row.activation_generation);
    const activatedAt = row.activated_at instanceof Date
      ? row.activated_at.toISOString()
      : String(row.activated_at);
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error("invalid release activation generation from database");
    }
    return {
      manifest_id: String(row.manifest_id),
      activation_generation: generation,
      activated_at: activatedAt,
      registration_idempotency_key: String(row.registration_idempotency_key),
    };
  }
}

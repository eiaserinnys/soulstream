import type postgres from "postgres";

import type { SqlClient } from "../../src/db/session_db.js";
import type { FullSchemaPostgresHarness } from "./full_schema_postgres_harness.js";
import type {
  AcquireInput,
  AcquireResult,
  CompleteIdentity,
  OwnerSnapshot,
  PartialIdentityResult,
  ReleaseResult,
  V1OwnerBoundary,
  V1OwnerMutation,
} from "./v1_sessions_row_owner_contract.js";

type PgSql = postgres.Sql<Record<string, unknown>>;
type PgTransaction = postgres.TransactionSql<Record<string, unknown>>;

interface DoubleRow {
  session_id: string;
  status: string;
  termination_event_id: number | null;
  execution_generation: string | number;
  execution_manifest_id: string | null;
  execution_runtime_env_identity: string | null;
  execution_registration_id: string | null;
  execution_pid: string | number | null;
  execution_start_identity: string | null;
  execution_command_id: string | null;
  execution_lease_expires_at: Date | null;
  effect_writes: string | number;
}

export async function createCounterfactualBoundary(
  harness: FullSchemaPostgresHarness,
  mutation?: V1OwnerMutation,
): Promise<V1OwnerBoundary> {
  const boundary = new CounterfactualBoundary(harness, mutation);
  await boundary.initialize();
  return boundary;
}

class CounterfactualBoundary implements V1OwnerBoundary {
  readonly label: string;
  private readonly sql: PgSql;
  private readonly barriers = new Map<string, TwoPartyBarrier>();

  constructor(
    private readonly harness: FullSchemaPostgresHarness,
    private readonly mutation?: V1OwnerMutation,
  ) {
    this.label = mutation ? `counterfactual:${mutation}` : "counterfactual:fixed";
    this.sql = asPg(harness.sql);
  }

  async initialize(): Promise<void> {
    await this.sql.unsafe("DROP TABLE IF EXISTS v1_sessions_owner_test_double");
    const identityCheck = this.mutation === "remove_identity_check"
      ? ""
      : `, CONSTRAINT v1_sessions_owner_identity_all_or_none CHECK (
          (execution_manifest_id IS NULL
           AND execution_runtime_env_identity IS NULL
           AND execution_registration_id IS NULL
           AND execution_pid IS NULL
           AND execution_start_identity IS NULL
           AND execution_command_id IS NULL
           AND execution_lease_expires_at IS NULL)
          OR
          (execution_manifest_id IS NOT NULL
           AND execution_runtime_env_identity IS NOT NULL
           AND execution_registration_id IS NOT NULL
           AND execution_pid IS NOT NULL
           AND execution_start_identity IS NOT NULL
           AND execution_command_id IS NOT NULL
           AND execution_lease_expires_at IS NOT NULL)
        )`;
    await this.sql.unsafe(`
      CREATE TABLE v1_sessions_owner_test_double (
        session_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        termination_event_id INTEGER,
        execution_generation BIGINT NOT NULL DEFAULT 0,
        execution_manifest_id TEXT,
        execution_runtime_env_identity TEXT,
        execution_registration_id TEXT,
        execution_pid BIGINT,
        execution_start_identity TEXT,
        execution_command_id TEXT,
        execution_lease_expires_at TIMESTAMPTZ,
        effect_writes INTEGER NOT NULL DEFAULT 0
        ${identityCheck}
      )
    `);
  }

  async resetSession(sessionId: string, status = "initializing"): Promise<void> {
    await this.sql`
      INSERT INTO v1_sessions_owner_test_double (session_id, status)
      VALUES (${sessionId}, ${status})
      ON CONFLICT (session_id) DO UPDATE SET
        status = EXCLUDED.status,
        termination_event_id = NULL,
        execution_generation = 0,
        execution_manifest_id = NULL,
        execution_runtime_env_identity = NULL,
        execution_registration_id = NULL,
        execution_pid = NULL,
        execution_start_identity = NULL,
        execution_command_id = NULL,
        execution_lease_expires_at = NULL,
        effect_writes = 0
    `;
  }

  async acquire(input: AcquireInput): Promise<AcquireResult> {
    const connection = asPg(this.harness.createPeer());
    if (this.mutation === "remove_for_update") {
      return await this.acquireWithoutLock(connection, input);
    }
    return await connection.begin(async (transaction) =>
      await this.acquireLocked(transaction, input));
  }

  async renew(
    sessionId: string,
    generation: number,
    identity: CompleteIdentity,
    leaseExpiresAt: Date,
  ): Promise<number> {
    const rows = this.mutation === "remove_generation_predicate"
      ? await this.sql<Array<{ execution_generation: string }>>`
          UPDATE v1_sessions_owner_test_double
          SET execution_lease_expires_at = ${leaseExpiresAt}
          WHERE session_id = ${sessionId}
            AND execution_manifest_id = ${identity.manifestId}
            AND execution_runtime_env_identity = ${identity.runtimeEnvIdentity}
            AND execution_registration_id = ${identity.registrationId}
            AND execution_pid = ${identity.pid}
            AND execution_start_identity = ${identity.startIdentity}
            AND execution_command_id = ${identity.executionCommandId}
          RETURNING execution_generation
        `
      : await this.sql<Array<{ execution_generation: string }>>`
          UPDATE v1_sessions_owner_test_double
          SET execution_lease_expires_at = ${leaseExpiresAt}
          WHERE session_id = ${sessionId}
            AND execution_generation = ${generation}
            AND execution_manifest_id = ${identity.manifestId}
            AND execution_runtime_env_identity = ${identity.runtimeEnvIdentity}
            AND execution_registration_id = ${identity.registrationId}
            AND execution_pid = ${identity.pid}
            AND execution_start_identity = ${identity.startIdentity}
            AND execution_command_id = ${identity.executionCommandId}
          RETURNING execution_generation
        `;
    return rows.length;
  }

  async writeStatus(sessionId: string, generation: number, status: string): Promise<number> {
    const rows = this.mutation === "remove_generation_predicate"
      ? await this.sql<Array<{ session_id: string }>>`
          UPDATE v1_sessions_owner_test_double SET status = ${status}
          WHERE session_id = ${sessionId}
          RETURNING session_id
        `
      : await this.sql<Array<{ session_id: string }>>`
          UPDATE v1_sessions_owner_test_double SET status = ${status}
          WHERE session_id = ${sessionId} AND execution_generation = ${generation}
          RETURNING session_id
        `;
    return rows.length;
  }

  async writeEffect(sessionId: string, generation: number): Promise<number> {
    const rows = this.mutation === "remove_generation_predicate"
      ? await this.sql<Array<{ session_id: string }>>`
          UPDATE v1_sessions_owner_test_double SET effect_writes = effect_writes + 1
          WHERE session_id = ${sessionId}
          RETURNING session_id
        `
      : await this.sql<Array<{ session_id: string }>>`
          UPDATE v1_sessions_owner_test_double SET effect_writes = effect_writes + 1
          WHERE session_id = ${sessionId} AND execution_generation = ${generation}
          RETURNING session_id
        `;
    return rows.length;
  }

  async release(
    sessionId: string,
    generation: number,
    _executionCommandId: string,
    options: { faultAfterTerminal?: boolean } = {},
  ): Promise<ReleaseResult> {
    if (this.mutation === "split_release_atomicity") {
      const projected = await this.sql<Array<{ session_id: string }>>`
        UPDATE v1_sessions_owner_test_double
        SET status = 'completed', termination_event_id = 9001
        WHERE session_id = ${sessionId} AND execution_generation = ${generation}
        RETURNING session_id
      `;
      if (options.faultAfterTerminal) {
        return { supported: true, appliedRows: projected.length, faulted: true };
      }
      await this.clearOwner(this.sql, sessionId, generation, true);
      return { supported: true, appliedRows: projected.length, faulted: false };
    }

    try {
      const appliedRows = await this.sql.begin(async (transaction) => {
        const rows = this.mutation === "remove_generation_predicate"
          ? await transaction<Array<{ session_id: string }>>`
              UPDATE v1_sessions_owner_test_double
              SET status = 'completed', termination_event_id = 9001,
                  execution_manifest_id = NULL,
                  execution_runtime_env_identity = NULL,
                  execution_registration_id = NULL,
                  execution_pid = NULL,
                  execution_start_identity = NULL,
                  execution_command_id = NULL,
                  execution_lease_expires_at = NULL
              WHERE session_id = ${sessionId}
              RETURNING session_id
            `
          : await transaction<Array<{ session_id: string }>>`
              UPDATE v1_sessions_owner_test_double
              SET status = 'completed', termination_event_id = 9001,
                  execution_manifest_id = NULL,
                  execution_runtime_env_identity = NULL,
                  execution_registration_id = NULL,
                  execution_pid = NULL,
                  execution_start_identity = NULL,
                  execution_command_id = NULL,
                  execution_lease_expires_at = NULL
              WHERE session_id = ${sessionId} AND execution_generation = ${generation}
              RETURNING session_id
            `;
        if (options.faultAfterTerminal && rows.length > 0) {
          throw new InjectedReleaseFault();
        }
        return rows.length;
      });
      return { supported: true, appliedRows, faulted: false };
    } catch (error) {
      if (error instanceof InjectedReleaseFault) {
        return { supported: true, appliedRows: 0, faulted: true };
      }
      throw error;
    }
  }

  async injectPartialIdentity(sessionId: string): Promise<PartialIdentityResult> {
    try {
      await this.sql`
        UPDATE v1_sessions_owner_test_double
        SET execution_manifest_id = 'partial-only'
        WHERE session_id = ${sessionId}
      `;
    } catch {
      return { supported: true, rejected: true, partialPersisted: false };
    }
    const snapshot = await this.snapshot(sessionId);
    const partialPersisted = snapshot.identity === null
      && (await this.rawRow(sessionId)).execution_manifest_id === "partial-only";
    return { supported: true, rejected: false, partialPersisted };
  }

  async snapshot(sessionId: string): Promise<OwnerSnapshot> {
    return rowToSnapshot(await this.rawRow(sessionId), true);
  }

  private async acquireLocked(
    transaction: PgTransaction,
    input: AcquireInput,
  ): Promise<AcquireResult> {
    const rows = await transaction<DoubleRow[]>`
      SELECT * FROM v1_sessions_owner_test_double
      WHERE session_id = ${input.sessionId}
      FOR UPDATE
    `;
    const row = requireRow(rows[0], input.sessionId);
    return await this.applyAcquire(transaction, row, input);
  }

  private async acquireWithoutLock(
    connection: PgSql,
    input: AcquireInput,
  ): Promise<AcquireResult> {
    const rows = await connection<DoubleRow[]>`
      SELECT * FROM v1_sessions_owner_test_double WHERE session_id = ${input.sessionId}
    `;
    const row = requireRow(rows[0], input.sessionId);
    if (input.raceKey) {
      let barrier = this.barriers.get(input.raceKey);
      if (!barrier) {
        barrier = new TwoPartyBarrier();
        this.barriers.set(input.raceKey, barrier);
      }
      await barrier.arrive();
    }
    return await this.applyAcquire(connection, row, input);
  }

  private async applyAcquire(
    connection: PgSql | PgTransaction,
    row: DoubleRow,
    input: AcquireInput,
  ): Promise<AcquireResult> {
    const currentIdentity = identityFromRow(row);
    const leaseActive = currentIdentity !== null
      && row.execution_lease_expires_at !== null
      && row.execution_lease_expires_at.getTime() > input.acquiredAt.getTime();
    if (leaseActive) {
      if (!sameIdentity(currentIdentity, input.identity)) {
        return { applied: false, generation: Number(row.execution_generation) };
      }
      await connection`
        UPDATE v1_sessions_owner_test_double
        SET execution_lease_expires_at = ${input.leaseExpiresAt}
        WHERE session_id = ${input.sessionId}
      `;
      return { applied: true, generation: Number(row.execution_generation) };
    }

    const generation = Number(row.execution_generation) + 1;
    await connection`
      UPDATE v1_sessions_owner_test_double
      SET status = 'running', execution_generation = ${generation},
          execution_manifest_id = ${input.identity.manifestId},
          execution_runtime_env_identity = ${input.identity.runtimeEnvIdentity},
          execution_registration_id = ${input.identity.registrationId},
          execution_pid = ${input.identity.pid},
          execution_start_identity = ${input.identity.startIdentity},
          execution_command_id = ${input.identity.executionCommandId},
          execution_lease_expires_at = ${input.leaseExpiresAt}
      WHERE session_id = ${input.sessionId}
    `;
    return { applied: true, generation };
  }

  private async clearOwner(
    connection: PgSql | PgTransaction,
    sessionId: string,
    generation: number,
    withGeneration: boolean,
  ): Promise<void> {
    if (withGeneration) {
      await connection`
        UPDATE v1_sessions_owner_test_double SET
          execution_manifest_id = NULL,
          execution_runtime_env_identity = NULL,
          execution_registration_id = NULL,
          execution_pid = NULL,
          execution_start_identity = NULL,
          execution_command_id = NULL,
          execution_lease_expires_at = NULL
        WHERE session_id = ${sessionId} AND execution_generation = ${generation}
      `;
    }
  }

  private async rawRow(sessionId: string): Promise<DoubleRow> {
    const rows = await this.sql<DoubleRow[]>`
      SELECT * FROM v1_sessions_owner_test_double WHERE session_id = ${sessionId}
    `;
    return requireRow(rows[0], sessionId);
  }
}

function asPg(sql: SqlClient): PgSql {
  return sql as unknown as PgSql;
}

function identityFromRow(row: DoubleRow): CompleteIdentity | null {
  if (
    row.execution_manifest_id === null
    || row.execution_runtime_env_identity === null
    || row.execution_registration_id === null
    || row.execution_pid === null
    || row.execution_start_identity === null
    || row.execution_command_id === null
  ) return null;
  return {
    manifestId: row.execution_manifest_id,
    runtimeEnvIdentity: row.execution_runtime_env_identity,
    registrationId: row.execution_registration_id,
    pid: Number(row.execution_pid),
    startIdentity: row.execution_start_identity,
    executionCommandId: row.execution_command_id,
  };
}

function rowToSnapshot(row: DoubleRow, ownerStoredOnSessionsRow: boolean): OwnerSnapshot {
  return {
    sessionId: row.session_id,
    status: row.status,
    terminalEventId: row.termination_event_id,
    generation: Number(row.execution_generation),
    identity: identityFromRow(row),
    leaseExpiresAt: row.execution_lease_expires_at,
    effectWrites: Number(row.effect_writes),
    ownerStoredOnSessionsRow,
  };
}

function sameIdentity(left: CompleteIdentity, right: CompleteIdentity): boolean {
  return left.manifestId === right.manifestId
    && left.runtimeEnvIdentity === right.runtimeEnvIdentity
    && left.registrationId === right.registrationId
    && left.pid === right.pid
    && left.startIdentity === right.startIdentity
    && left.executionCommandId === right.executionCommandId;
}

function requireRow<T>(row: T | undefined, identity: string): T {
  if (!row) throw new Error(`V1 owner harness row missing: ${identity}`);
  return row;
}

class InjectedReleaseFault extends Error {}

class TwoPartyBarrier {
  private arrivals = 0;
  private readonly promise: Promise<void>;
  private release!: () => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  async arrive(): Promise<void> {
    this.arrivals += 1;
    if (this.arrivals === 2) this.release();
    await this.promise;
  }
}

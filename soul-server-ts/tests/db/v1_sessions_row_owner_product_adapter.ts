import type postgres from "postgres";

import type { SqlClient } from "../../src/db/session_db.js";
import type { FullSchemaPostgresHarness } from "./full_schema_postgres_harness.js";
import type {
  AcquireInput,
  AcquireResult,
  OwnerSnapshot,
  PartialIdentityResult,
  ReleaseResult,
  V1OwnerBoundary,
} from "./v1_sessions_row_owner_contract.js";

type PgSql = postgres.Sql<Record<string, unknown>>;

export function createCurrentProductBoundary(
  harness: FullSchemaPostgresHarness,
): V1OwnerBoundary {
  return new CurrentProductBoundary(harness);
}

class CurrentProductBoundary implements V1OwnerBoundary {
  readonly label = "origin-main:legacy-ownership";
  private readonly sql: PgSql;

  constructor(private readonly harness: FullSchemaPostgresHarness) {
    this.sql = asPg(harness.sql);
  }

  async resetSession(sessionId: string, status = "initializing"): Promise<void> {
    await this.sql`DELETE FROM session_execution_ownerships WHERE session_id = ${sessionId}`;
    await this.sql`DELETE FROM sessions WHERE session_id = ${sessionId}`;
    await this.sql`
      INSERT INTO sessions (session_id, session_type, status, agent_id)
      VALUES (${sessionId}, 'codex', ${status}, 'v1-red')
    `;
  }

  async acquire(input: AcquireInput): Promise<AcquireResult> {
    const connection = asPg(this.harness.createPeer());
    if (input.path === "legacy_adopt") {
      const adopted = await connection<Array<{ applied: boolean }>>`
        SELECT * FROM session_reserve_execution_adoption_v2(
          ${input.sessionId}, ${input.candidateGeneration},
          ${input.identity.manifestId}, ${input.identity.runtimeEnvIdentity},
          ${input.identity.registrationId}, ${input.identity.pid},
          ${input.identity.startIdentity}, ${input.identity.executionCommandId},
          ${input.acquiredAt}
        )
      `;
      if (adopted[0]?.applied !== true) return { applied: false, generation: null };
    } else {
      const reserved = await connection<Array<{
        applied: boolean;
        ownership_generation: string | number;
      }>>`
        SELECT * FROM session_reserve_execution_ownership_v2(
          ${input.sessionId}, ${input.candidateGeneration}, 'in_process',
          ${input.identity.manifestId}, ${input.identity.runtimeEnvIdentity},
          ${input.acquiredAt}
        )
      `;
      if (reserved[0]?.applied !== true) {
        return {
          applied: false,
          generation: Number(reserved[0]?.ownership_generation ?? 0) || null,
        };
      }
    }
    const proof = await connection<Array<{ applied: boolean }>>`
      SELECT session_prove_execution_ownership(
        ${input.sessionId}, ${input.candidateGeneration},
        ${input.identity.registrationId}, ${input.identity.pid},
        ${input.identity.startIdentity}, ${input.identity.executionCommandId},
        ${input.acquiredAt}
      ) AS applied
    `;
    if (proof[0]?.applied !== true) return { applied: false, generation: null };
    const activation = await connection<Array<{ applied: boolean }>>`
      SELECT * FROM session_activate_execution_ownership(
        ${input.sessionId}, ${input.candidateGeneration}, 'not_required',
        NULL, FALSE, ${input.acquiredAt}
      )
    `;
    return {
      applied: activation[0]?.applied === true,
      generation: activation[0]?.applied === true ? input.candidateGeneration : null,
    };
  }

  async renew(): Promise<number> {
    return 0;
  }

  async writeStatus(): Promise<number> {
    return 0;
  }

  async writeEffect(): Promise<number> {
    return 0;
  }

  async release(
    sessionId: string,
    generation: number,
    executionCommandId: string,
    options: { faultAfterTerminal?: boolean } = {},
  ): Promise<ReleaseResult> {
    if (options.faultAfterTerminal) {
      return { supported: false, appliedRows: 0, faulted: false };
    }
    const rows = await this.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_project_runner_terminal_fact(
        ${sessionId}, ${generation}, ${executionCommandId}, 'completed',
        NULL, 'not_required', NULL, 9001, NOW()
      )
    `;
    return {
      supported: true,
      appliedRows: rows[0]?.applied === true ? 1 : 0,
      faulted: false,
    };
  }

  async injectPartialIdentity(): Promise<PartialIdentityResult> {
    return { supported: false, rejected: false, partialPersisted: false };
  }

  async snapshot(sessionId: string): Promise<OwnerSnapshot> {
    const sessionsRows = await this.sql<Array<{
      session_id: string;
      status: string;
      termination_event_id: number | null;
    }>>`
      SELECT session_id, status, termination_event_id
      FROM sessions WHERE session_id = ${sessionId}
    `;
    const session = requireRow(sessionsRows[0], sessionId);
    const ownershipRows = await this.sql<Array<{
      ownership_generation: string | number;
      manifest_id: string | null;
      runtime_env_identity: string | null;
      registration_id: string | null;
      pid: number | null;
      start_identity: string | null;
      execution_command_id: string | null;
      reservation_expires_at: Date | null;
      phase: string;
    }>>`
      SELECT ownership_generation, manifest_id, runtime_env_identity,
             registration_id, pid, start_identity, execution_command_id,
             reservation_expires_at, phase
      FROM session_execution_ownerships
      WHERE session_id = ${sessionId}
      ORDER BY ownership_generation DESC
      LIMIT 1
    `;
    const owner = ownershipRows[0];
    const identity = owner && owner.phase !== "terminal" && owner.manifest_id
      && owner.runtime_env_identity && owner.registration_id && owner.pid
      && owner.start_identity && owner.execution_command_id
      ? {
          manifestId: owner.manifest_id,
          runtimeEnvIdentity: owner.runtime_env_identity,
          registrationId: owner.registration_id,
          pid: owner.pid,
          startIdentity: owner.start_identity,
          executionCommandId: owner.execution_command_id,
        }
      : null;
    return {
      sessionId,
      status: session.status,
      terminalEventId: session.termination_event_id,
      generation: Number(owner?.ownership_generation ?? 0),
      identity,
      leaseExpiresAt: owner?.reservation_expires_at ?? null,
      effectWrites: 0,
      ownerStoredOnSessionsRow: false,
    };
  }
}

function asPg(sql: SqlClient): PgSql {
  return sql as unknown as PgSql;
}

function requireRow<T>(row: T | undefined, identity: string): T {
  if (!row) throw new Error(`V1 current product row missing: ${identity}`);
  return row;
}

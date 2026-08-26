import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import {
  EventIngressRepository,
  type EventIngressSql,
} from "../../../orch-server-ts/src/node/event_ingress_repository.js";
import { applyEventSessionEffect } from
  "../../../orch-server-ts/src/node/event_session_effect_applier.js";
import type {
  EventAppendBatch,
  EventIngressEnvelope,
  EventSessionEffect,
} from "../../../orch-server-ts/src/node/event_ingress_types.js";
import type { SqlClient } from "../../src/db/session_db.js";
import { computeEventOutboxPayloadHash } from "../../src/upstream/event_outbox.js";
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
  readonly label = "v1:sessions-row-owner";
  private readonly sql: PgSql;
  private readonly streamId = randomUUID();
  private sourceSeq = 0;
  private readonly ingress: EventIngressRepository;

  constructor(private readonly harness: FullSchemaPostgresHarness) {
    this.sql = asPg(harness.sql);
    this.ingress = new EventIngressRepository(
      { resolveSql: async () => harness.sql as unknown as EventIngressSql },
      applyEventSessionEffect,
    );
  }

  async resetSession(sessionId: string, status = "initializing"): Promise<void> {
    await this.sql`DELETE FROM sessions WHERE session_id = ${sessionId}`;
    await this.sql`
      INSERT INTO sessions (session_id, session_type, status, agent_id)
      VALUES (${sessionId}, 'codex', ${status}, 'v1-green')
    `;
  }

  async acquire(input: AcquireInput): Promise<AcquireResult> {
    const connection = asPg(this.harness.createPeer());
    const rows = await connection<Array<{
      applied: boolean;
      execution_generation: string | number;
    }>>`
      SELECT * FROM session_acquire_execution_ownership(
        ${input.sessionId},
        ${input.identity.manifestId},
        ${input.identity.runtimeEnvIdentity},
        ${input.identity.registrationId},
        ${input.identity.pid},
        ${input.identity.startIdentity},
        ${input.identity.executionCommandId},
        ${input.leaseExpiresAt},
        'not_required',
        NULL,
        FALSE,
        ${input.acquiredAt}
      )
    `;
    const row = requireRow(rows[0], input.sessionId);
    return {
      applied: row.applied,
      generation: Number(row.execution_generation) || null,
    };
  }

  async renew(
    sessionId: string,
    generation: number,
    identity: AcquireInput["identity"],
    leaseExpiresAt: Date,
  ): Promise<number> {
    const rows = await this.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_renew_execution_ownership(
        ${sessionId}, ${generation}, ${identity.manifestId},
        ${identity.runtimeEnvIdentity}, ${identity.registrationId}, ${identity.pid},
        ${identity.startIdentity}, ${identity.executionCommandId},
        ${leaseExpiresAt}, NOW()
      )
    `;
    return rows[0]?.applied === true ? 1 : 0;
  }

  async writeStatus(sessionId: string, generation: number, status: string): Promise<number> {
    const outcome = await this.commitGenerationEvent(sessionId, generation, {
      kind: "running_transition",
      review_state: "not_required",
      updated_at: new Date().toISOString(),
    }, { requested_status: status });
    return outcome === "committed" ? 1 : 0;
  }

  async writeEffect(sessionId: string, generation: number): Promise<number> {
    const now = new Date().toISOString();
    const outcome = await this.commitGenerationEvent(sessionId, generation, {
      kind: "append_metadata",
      entry: { type: "v1_strict_effect", value: generation },
      updated_at: now,
    }, { effect: "v1_strict_effect" });
    return outcome === "committed" ? 1 : 0;
  }

  async release(
    sessionId: string,
    generation: number,
    executionCommandId: string,
    options: { faultAfterTerminal?: boolean } = {},
  ): Promise<ReleaseResult> {
    if (options.faultAfterTerminal) {
      try {
        await this.sql.begin(async (transaction) => {
          await releaseRow(transaction as PgSql, sessionId, generation, executionCommandId);
          throw new Error("V1_STRICT_RELEASE_FAULT");
        });
      } catch (error) {
        if ((error as Error).message !== "V1_STRICT_RELEASE_FAULT") throw error;
      }
      return { supported: true, appliedRows: 0, faulted: true };
    }
    const appliedRows = await releaseRow(this.sql, sessionId, generation, executionCommandId);
    return { supported: true, appliedRows, faulted: false };
  }

  async injectPartialIdentity(sessionId: string): Promise<PartialIdentityResult> {
    let rejected = false;
    try {
      await this.sql`
        UPDATE sessions SET execution_manifest_id = 'partial-only'
        WHERE session_id = ${sessionId}
      `;
    } catch {
      rejected = true;
    }
    const rows = await this.sql<Array<{ execution_manifest_id: string | null }>>`
      SELECT execution_manifest_id FROM sessions WHERE session_id = ${sessionId}
    `;
    return {
      supported: true,
      rejected,
      partialPersisted: rows[0]?.execution_manifest_id !== null,
    };
  }

  async snapshot(sessionId: string): Promise<OwnerSnapshot> {
    const rows = await this.sql<Array<{
      status: string;
      termination_event_id: number | null;
      execution_generation: string | number;
      execution_manifest_id: string | null;
      execution_runtime_env_identity: string | null;
      execution_registration_id: string | null;
      execution_pid: number | null;
      execution_start_identity: string | null;
      execution_command_id: string | null;
      execution_lease_expires_at: Date | null;
      effect_writes: string | number;
    }>>`
      SELECT session.status, session.termination_event_id,
             session.execution_generation, session.execution_manifest_id,
             session.execution_runtime_env_identity,
             session.execution_registration_id, session.execution_pid,
             session.execution_start_identity, session.execution_command_id,
             session.execution_lease_expires_at,
             (SELECT COUNT(*) FROM events WHERE session_id = ${sessionId}) AS effect_writes
      FROM sessions AS session WHERE session.session_id = ${sessionId}
    `;
    const row = requireRow(rows[0], sessionId);
    const identity = row.execution_manifest_id
      && row.execution_runtime_env_identity
      && row.execution_registration_id
      && row.execution_pid
      && row.execution_start_identity
      && row.execution_command_id
      ? {
          manifestId: row.execution_manifest_id,
          runtimeEnvIdentity: row.execution_runtime_env_identity,
          registrationId: row.execution_registration_id,
          pid: row.execution_pid,
          startIdentity: row.execution_start_identity,
          executionCommandId: row.execution_command_id,
        }
      : null;
    return {
      sessionId,
      status: row.status,
      terminalEventId: row.termination_event_id,
      generation: Number(row.execution_generation),
      identity,
      leaseExpiresAt: row.execution_lease_expires_at,
      effectWrites: Number(row.effect_writes),
      ownerStoredOnSessionsRow: true,
    };
  }

  private async commitGenerationEvent(
    sessionId: string,
    generation: number,
    sessionEffect: EventSessionEffect,
    payload: Record<string, unknown>,
  ): Promise<"committed" | "dead_lettered"> {
    const sourceSeq = ++this.sourceSeq;
    const createdAt = new Date().toISOString();
    const unsigned = {
      stream_id: this.streamId,
      source_seq: sourceSeq,
      session_id: sessionId,
      execution_generation: generation,
      event_type: "metadata",
      payload,
      searchable_text: null,
      created_at: createdAt,
      semantic_dedupe_key: `v1-strict:${sessionId}:${sourceSeq}`,
      session_effect: sessionEffect,
    } satisfies Omit<EventIngressEnvelope, "payload_hash">;
    const envelope: EventIngressEnvelope = {
      ...unsigned,
      payload_hash: computeEventOutboxPayloadHash(unsigned),
    };
    const batch: EventAppendBatch = {
      type: "event_append_batch",
      protocol_version: 1,
      stream_id: this.streamId,
      first_seq: sourceSeq,
      events: [envelope],
    };
    return (await this.ingress.commitBatch("v1-strict", batch))[0]!.outcome;
  }
}

async function releaseRow(
  sql: PgSql,
  sessionId: string,
  generation: number,
  executionCommandId: string,
): Promise<number> {
  const rows = await sql<Array<{ applied: boolean }>>`
    SELECT * FROM session_release_execution_ownership(
      ${sessionId}, ${generation}, ${executionCommandId}, 'completed',
      NULL, 'not_required', NULL, 9001, NOW()
    )
  `;
  return rows[0]?.applied === true ? 1 : 0;
}

function asPg(sql: SqlClient): PgSql {
  return sql as unknown as PgSql;
}

function requireRow<T>(row: T | undefined, identity: string): T {
  if (!row) throw new Error(`V1 current product row missing: ${identity}`);
  return row;
}

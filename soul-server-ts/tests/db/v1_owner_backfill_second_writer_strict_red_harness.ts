import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";

import {
  EventIngressRepository,
  type EventIngressSql,
} from "../../../orch-server-ts/src/node/event_ingress_repository.js";
import { applyEventSessionEffect } from
  "../../../orch-server-ts/src/node/event_session_effect_applier.js";
import { SessionReadRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_read_repository.js";
import {
  buildEventOutboxAppendInput,
  EventPersistence,
} from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { OwnerNullExecutionReconciler } from
  "../../src/runner/owner_null_execution_reconciler.js";
import { OwnerNullInventoryReconciler } from
  "../../src/runner/owner_null_inventory_reconciler.js";
import type { RunnerRecoveryCoordinatorOptions } from
  "../../src/runner/runner_recovery_coordinator_options.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import type { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";
import { TaskRunnerRecovery } from "../../src/task/task_runner_recovery.js";
import {
  EventOutbox,
  type EventOutboxSessionEffect,
} from "../../src/upstream/event_outbox.js";
import { EventOutboxPump, type EventAppendAck } from
  "../../src/upstream/event_outbox_pump.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import type { FullSchemaPostgresHarness } from "./full_schema_postgres_harness.js";

const logger = pino({ level: "silent" });
const NODE_ID = "node-b-red";
const BASE_TIME_MS = Date.parse("2026-08-27T00:00:00.000Z");

export interface BOwnerSnapshot {
  status: string;
  terminationReason: string | null;
  terminationDetail: string | null;
  sessionGeneration: number;
  manifestId: string | null;
  runtimeEnvIdentity: string | null;
  registrationId: string | null;
  pid: number | null;
  startIdentity: string | null;
  executionCommandId: string | null;
  legacyActive: number;
}

export const LIVE_IDENTITY = {
  manifestId: "manifest-b-red",
  runtimeEnvIdentity: "runtime-b-red",
  registrationId: "registration-b-red",
  pid: 4123,
  startIdentity: "start-b-red",
  executionCommandId: "execute-b-red",
} as const;

export function secondWriterViolations(snapshot: BOwnerSnapshot): string[] {
  if (snapshot.legacyActive === 0) return [];
  return [
    "B_SECOND_WRITER_RED"
      + ` legacyActive=${snapshot.legacyActive}`
      + ` sessionGeneration=${snapshot.sessionGeneration}`
      + ` canonicalOwner=${snapshot.manifestId ?? "null"}`,
  ];
}

export class BSecondWriterProductHarness {
  readonly persistence: EventPersistence;
  readonly sessionReads: SessionReadRepository;
  private readonly clockAnchorMs: number;
  private readonly directory: string;
  private readonly outbox: EventOutbox;
  private readonly pump: EventOutboxPump;

  private constructor(
    readonly postgres: FullSchemaPostgresHarness,
    directory: string,
    outbox: EventOutbox,
    pump: EventOutboxPump,
    clockAnchorMs: number,
  ) {
    this.clockAnchorMs = clockAnchorMs;
    this.directory = directory;
    this.outbox = outbox;
    this.pump = pump;
    this.persistence = new EventPersistence(
      {} as SessionDB,
      {} as SessionBroadcaster,
      logger,
      outbox,
      pump,
    );
    this.sessionReads = new SessionReadRepository(
      postgres.sql as ConstructorParameters<typeof SessionReadRepository>[0],
    );
  }

  static async create(
    postgres: FullSchemaPostgresHarness,
  ): Promise<BSecondWriterProductHarness> {
    const directory = await mkdtemp(join(tmpdir(), "b-second-writer-red-"));
    const outbox = await EventOutbox.open(directory);
    const ingress = new EventIngressRepository(
      { resolveSql: async () => postgres.sql as unknown as EventIngressSql },
      applyEventSessionEffect,
    );
    let pump!: EventOutboxPump;
    pump = new EventOutboxPump(outbox, () => undefined, {
      acknowledgementTimeoutMs: 5_000,
    });
    void pump.connect(async (batch) => {
      let ack: EventAppendAck;
      try {
        const results = await ingress.commitBatch(NODE_ID, batch);
        ack = {
          type: "event_append_ack",
          stream_id: batch.stream_id,
          acked_through: batch.events.at(-1)!.source_seq,
          events: results.map((result) => {
            if (result.outcome === "dead_lettered") {
              return {
                source_seq: result.envelope.source_seq,
                dead_letter: {
                  code: result.deadLetter.code,
                  reason: result.deadLetter.reason,
                  rejected_at: result.deadLetter.rejectedAt,
                },
              };
            }
            return {
              source_seq: result.envelope.source_seq,
              event_id: result.eventId,
              ...(result.sessionEffectApplication?.canonicalSession
                ? {
                    effect_application: {
                      applied: result.sessionEffectApplication.applied,
                      canonical_session: result.sessionEffectApplication.canonicalSession,
                      ...(result.sessionEffectApplication.canonicalExecutionOwnership === undefined
                        ? {}
                        : {
                            canonical_execution_ownership:
                              result.sessionEffectApplication.canonicalExecutionOwnership,
                          }),
                    },
                  }
                : {}),
            };
          }),
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ack = {
          type: "event_append_ack",
          stream_id: batch.stream_id,
          acked_through: batch.events.at(-1)!.source_seq,
          events: batch.events.map((event) => ({
            source_seq: event.source_seq,
            dead_letter: {
              code: "TEST_INGRESS_FAILURE",
              reason,
              rejected_at: new Date().toISOString(),
            },
          })),
        };
      }
      await pump.handleAck(ack);
    });
    const [clock] = await postgres.sql<Array<{ now_ms: number | string }>>`
      SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
    `;
    if (!clock) throw new Error("PostgreSQL clock anchor missing");
    return new BSecondWriterProductHarness(
      postgres,
      directory,
      outbox,
      pump,
      Number(clock.now_ms),
    );
  }

  async cleanup(): Promise<void> {
    this.pump.disconnect();
    await rm(this.directory, { recursive: true, force: true });
  }

  async resetRunningSession(sessionId: string): Promise<void> {
    await this.postgres.sql`DELETE FROM sessions WHERE session_id = ${sessionId}`;
    await this.postgres.sql`
      INSERT INTO sessions (
        session_id, session_type, status, agent_id, node_id, review_state
      ) VALUES (
        ${sessionId}, 'codex', 'running', 'b-red-agent', ${NODE_ID}, 'not_required'
      )
    `;
  }

  async publishOldSoulBackfill(
    sessionId: string,
    options: {
      runtimeEnvIdentity?: string;
      evidenceHash: string;
    },
  ): Promise<{ applied: boolean }> {
    const firstObservedAt = new Date(BASE_TIME_MS);
    const secondObservedAt = new Date(BASE_TIME_MS + 1_000);
    const runtimeFields = options.runtimeEnvIdentity === undefined
      ? {}
      : {
          first_runtime_env_identity: options.runtimeEnvIdentity,
          second_runtime_env_identity: options.runtimeEnvIdentity,
        };
    const effect: EventOutboxSessionEffect = {
      kind: "execution_backfill",
      first_manifest_id: LIVE_IDENTITY.manifestId,
      ...runtimeFields,
      first_registration_id: LIVE_IDENTITY.registrationId,
      first_pid: LIVE_IDENTITY.pid,
      first_start_identity: LIVE_IDENTITY.startIdentity,
      first_execution_command_id: LIVE_IDENTITY.executionCommandId,
      first_observed_at: firstObservedAt.toISOString(),
      second_manifest_id: LIVE_IDENTITY.manifestId,
      second_registration_id: LIVE_IDENTITY.registrationId,
      second_pid: LIVE_IDENTITY.pid,
      second_start_identity: LIVE_IDENTITY.startIdentity,
      second_execution_command_id: LIVE_IDENTITY.executionCommandId,
      second_observed_at: secondObservedAt.toISOString(),
      evidence_hash: options.evidenceHash,
      minimum_lease_interval_ms: 1_000,
      probe_only: false,
      updated_at: secondObservedAt.toISOString(),
    };
    const record = await this.outbox.append(buildEventOutboxAppendInput(
      sessionId,
      {
        type: "metadata",
        metadata_type: "execution_ownership_backfill",
        value: { source: "old-soul-rolling-drain" },
        timestamp: secondObservedAt,
      },
      effect,
    ));
    const acknowledgement = await this.pump.waitForAcknowledgementResult(
      record,
      { timeoutMs: 5_000 },
    );
    if (!acknowledgement.effect_application) {
      throw new Error("old-soul backfill acknowledgement missing effect application");
    }
    return acknowledgement.effect_application;
  }

  createRecovery(): TaskRunnerRecovery {
    const lifecycleTransition = new TaskLifecycleTransition({
      logger,
      persistence: this.persistence,
    });
    return new TaskRunnerRecovery({
      getTask: () => undefined,
      loadTask: async () => null,
      rememberTask: () => undefined,
      lifecycleTransition,
      autoResumeTransition: {} as AutoResumeTransition,
      persistence: this.persistence,
    });
  }

  createLiveReconciler(
    task: Task,
    registration: RunnerRegistration,
    recovery: TaskRunnerRecovery,
  ): { reconcile(): Promise<"proceed" | "wait" | "terminal">; advance(): void } {
    let now = this.clockAnchorMs;
    const taskManager = {
      reconcileExecutionOwnershipObservations:
        recovery.reconcileExecutionOwnershipObservations.bind(recovery),
    } as RunnerRecoveryCoordinatorOptions["taskManager"];
    const reconciler = new OwnerNullExecutionReconciler({
      taskManager,
      scanIntervalMs: 1_000,
      leaseTimeoutMs: 60_000,
      now: () => now,
    });
    return {
      reconcile: async () => await reconciler.reconcile(task, registration),
      advance: () => {
        now += 1_000;
      },
    };
  }

  createAbsentReconciler(
    task: Task,
    recovery: TaskRunnerRecovery,
  ): { reconcile(): Promise<void>; advance(): void } {
    let now = this.clockAnchorMs;
    const taskManager = {
      listOwnerNullRunningInventory: async (nodeId: string, limit = 100) =>
        await this.sessionReads.listOwnerNullRunningInventory({ nodeId, limit }),
      hydrateRunnerRecoveryTask: async (sessionId: string) =>
        sessionId === task.agentSessionId ? task : null,
      reconcileExecutionOwnershipObservations:
        recovery.reconcileExecutionOwnershipObservations.bind(recovery),
    };
    const reconciler = new OwnerNullInventoryReconciler({
      nodeId: NODE_ID,
      taskManager,
      scanIntervalMs: 1_000,
      leaseTimeoutMs: 60_000,
      logger,
      now: () => now,
    });
    return {
      reconcile: async () => await reconciler.reconcile([]),
      advance: () => {
        now += 1_000;
      },
    };
  }

  async snapshot(sessionId: string): Promise<BOwnerSnapshot> {
    const rows = await this.postgres.sql<Array<{
      status: string;
      termination_reason: string | null;
      termination_detail: string | null;
      execution_generation: number | string;
      execution_manifest_id: string | null;
      execution_runtime_env_identity: string | null;
      execution_registration_id: string | null;
      execution_pid: number | null;
      execution_start_identity: string | null;
      execution_command_id: string | null;
      legacy_active: number | string;
    }>>`
      SELECT
        session.status,
        session.termination_reason,
        session.termination_detail,
        session.execution_generation,
        session.execution_manifest_id,
        session.execution_runtime_env_identity,
        session.execution_registration_id,
        session.execution_pid,
        session.execution_start_identity,
        session.execution_command_id,
        (
          SELECT COUNT(*)::int
          FROM session_execution_ownerships AS ownership
          WHERE ownership.session_id = session.session_id
            AND ownership.phase = 'active'
        ) AS legacy_active
      FROM sessions AS session
      WHERE session.session_id = ${sessionId}
    `;
    const row = rows[0];
    if (!row) throw new Error(`session snapshot missing: ${sessionId}`);
    return {
      status: row.status,
      terminationReason: row.termination_reason,
      terminationDetail: row.termination_detail,
      sessionGeneration: Number(row.execution_generation),
      manifestId: row.execution_manifest_id,
      runtimeEnvIdentity: row.execution_runtime_env_identity,
      registrationId: row.execution_registration_id,
      pid: row.execution_pid,
      startIdentity: row.execution_start_identity,
      executionCommandId: row.execution_command_id,
      legacyActive: Number(row.legacy_active),
    };
  }
}

export function makeOwnerNullTask(sessionId: string): Task {
  return {
    agentSessionId: sessionId,
    prompt: "continue",
    status: "running",
    createdAt: new Date(BASE_TIME_MS),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    hydratedFromDb: true,
  };
}

export function makeLiveRegistration(sessionId: string): RunnerRegistration {
  return {
    config: {
      sessionId,
      codeSha: LIVE_IDENTITY.manifestId,
      releaseManifestId: LIVE_IDENTITY.manifestId,
      runtimeEnvIdentity: LIVE_IDENTITY.runtimeEnvIdentity,
    } as RunnerRegistration["config"],
    pid: LIVE_IDENTITY.pid,
    pidAlive: true,
    registeredAtMs: BASE_TIME_MS,
    registrationId: LIVE_IDENTITY.registrationId,
    pidStartIdentity: LIVE_IDENTITY.startIdentity,
    bootstrap: null,
    lifecycle: {
      execution_command_id: LIVE_IDENTITY.executionCommandId,
      execution_state: "running",
    } as RunnerRegistration["lifecycle"],
  };
}

export function stableObservation(
  observedAt: Date,
  runtimeEnvIdentity: string | null = LIVE_IDENTITY.runtimeEnvIdentity,
) {
  return {
    manifestId: LIVE_IDENTITY.manifestId,
    runtimeEnvIdentity,
    registrationId: LIVE_IDENTITY.registrationId,
    pid: LIVE_IDENTITY.pid,
    startIdentity: LIVE_IDENTITY.startIdentity,
    executionCommandId: LIVE_IDENTITY.executionCommandId,
    observedAt,
  };
}

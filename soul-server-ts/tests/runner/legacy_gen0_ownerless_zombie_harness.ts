import type { Logger } from "pino";

import type { SessionRow } from "../../src/db/session_db.js";
import { RunnerRecoveryCoordinator, type RunnerRecoveryCoordinatorOptions } from
  "../../src/runner/runner_recovery_coordinator.js";
import type { RunnerRegistration } from
  "../../src/runner/runner_process_registry.js";
import { composeRunnerReconciliationReporter } from
  "../../src/runtime/runner_process_composition.js";
import type { AutoResumeTransition } from
  "../../src/task/task_auto_resume_transition.js";
import { hydrateEvictedTaskFromSessionRow } from
  "../../src/task/task_evicted_hydration.js";
import { TaskLifecycleTransition } from
  "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";
import { TaskRunnerRecovery } from "../../src/task/task_runner_recovery.js";
import type { FullSchemaPostgresHarness } from
  "../db/full_schema_postgres_harness.js";
import type {
  LegacyGen0OwnerlessMatrixObservation,
  LegacyOwnerlessRowSnapshot,
} from "./legacy_gen0_ownerless_zombie_oracle.js";
import {
  LIVE_OWNER_IDENTITY,
  makeOwnerlessRegistration,
  OWNERLESS_NODE_ID,
} from "./ownerless_running_reconciliation_fixture.js";
import { OwnerlessIngressHarness } from
  "./ownerless_running_ingress_harness.js";

const GEN0_SESSION_ID = "legacy-gen0-no-ownership-row";
const GEN_POSITIVE_CLOSED_ID = "legacy-gen-positive-closed-owner";
const LIVE_OWNER_ID = "legacy-full-proven-live-owner";
const TERMINAL_CONTROL_ID = "legacy-terminal-control";
const STALE_TERMINAL_EVENT_ID = 1;
const STARTUP_AT_MS = Date.parse("2026-08-28T00:00:00.000Z");
const SCAN_INTERVAL_MS = 1_000;
const LEASE_TIMEOUT_MS = 60_000;

export class LegacyGen0OwnerlessZombieHarness {
  private constructor(
    readonly postgres: FullSchemaPostgresHarness,
    private readonly ingress: OwnerlessIngressHarness,
  ) {}

  static async create(
    postgres: FullSchemaPostgresHarness,
  ): Promise<LegacyGen0OwnerlessZombieHarness> {
    return new LegacyGen0OwnerlessZombieHarness(
      postgres,
      await OwnerlessIngressHarness.create(postgres),
    );
  }

  async cleanup(): Promise<void> {
    await this.ingress.cleanup();
  }

  async observeStartupReconnectMatrix(): Promise<LegacyGen0OwnerlessMatrixObservation> {
    await this.insertRunning(GEN0_SESSION_ID);
    await this.seedStaleTerminalEvidence(GEN0_SESSION_ID);
    await this.insertRunning(GEN_POSITIVE_CLOSED_ID);
    await this.acquireOwner(GEN_POSITIVE_CLOSED_ID, STARTUP_AT_MS - 3_000);
    await this.insertRunning(LIVE_OWNER_ID);
    await this.acquireOwner(LIVE_OWNER_ID, STARTUP_AT_MS - 2_000);
    await this.insertRunning(TERMINAL_CONTROL_ID);
    await this.terminalizeControl(TERMINAL_CONTROL_ID, STARTUP_AT_MS - 1_000);

    const initialGen0 = await this.snapshot(GEN0_SESSION_ID);
    const initialTerminalControl = await this.snapshot(TERMINAL_CONTROL_ID);
    const inventory = await this.ingress.sessionReads.listOwnerNullRunningInventory({
      nodeId: OWNERLESS_NODE_ID,
      limit: 100,
    });
    const clock = { value: STARTUP_AT_MS };
    const registrations = [
      closedRegistration(GEN0_SESSION_ID, clock.value),
      closedRegistration(GEN_POSITIVE_CLOSED_ID, clock.value),
      makeOwnerlessRegistration(LIVE_OWNER_ID, clock.value),
      closedRegistration(TERMINAL_CONTROL_ID, clock.value),
    ];
    const coordinator = this.composeCoordinator(registrations, clock);
    const reporter = composeRunnerReconciliationReporter(
      {
        SOUL_RUNNER_STATE_DIR: "/runner/legacy-gen0-red",
        SOUL_RUNNER_LEASE_TIMEOUT_MS: LEASE_TIMEOUT_MS,
      } as never,
      {} as never,
      coordinator,
      { info: () => undefined } as never,
    );

    await coordinator.scanOnce();
    await coordinator.waitForSettled();
    clock.value += SCAN_INTERVAL_MS;
    await reporter.waitForRunnerReconciliation!();
    await coordinator.waitForSettled();
    await coordinator.stop();

    const gen0NoOwnershipRow = await this.snapshot(GEN0_SESSION_ID);
    const genPositiveClosedOwner = await this.snapshot(GEN_POSITIVE_CLOSED_ID);
    const fullProvenLiveOwner = await this.snapshot(LIVE_OWNER_ID);
    const terminalControl = await this.snapshot(TERMINAL_CONTROL_ID);
    const rows = [
      gen0NoOwnershipRow,
      genPositiveClosedOwner,
      fullProvenLiveOwner,
      terminalControl,
    ];
    return {
      inventorySessionIds: inventory.map((row) => row.session_id).sort(),
      scanPhases: ["startup", "reconnect"],
      gen0InitialTerminalEventId: initialGen0.terminationEventId!,
      gen0InitialTerminalEventCount: initialGen0.terminalEventCount,
      gen0NoOwnershipRow,
      genPositiveClosedOwner,
      fullProvenLiveOwner,
      terminalControl,
      terminalControlInitialEventCount: initialTerminalControl.terminalEventCount,
      ownerlessRunningCount: rows.filter(
        (row) => row.status === "running" && row.activeOwnershipRows === 0,
      ).length,
      statusOnlyTerminalWrites: rows.filter(
        (row) => isTerminal(row.status) && (
          row.terminationReason === null
          || row.terminationDetail === null
          || row.terminationEventId === null
        ),
      ).length,
    };
  }

  private composeCoordinator(
    registrations: RunnerRegistration[],
    clock: { value: number },
  ): RunnerRecoveryCoordinator {
    const tasks = new Map<string, Task>();
    const logger = silentLogger();
    const lifecycleTransition = new TaskLifecycleTransition({
      logger,
      persistence: this.ingress.persistence,
    });
    const recovery = new TaskRunnerRecovery({
      getTask: (sessionId) => tasks.get(sessionId),
      loadTask: async (sessionId) => await this.loadTask(sessionId, logger),
      rememberTask: (task) => tasks.set(task.agentSessionId, task),
      lifecycleTransition,
      autoResumeTransition: {} as AutoResumeTransition,
      persistence: this.ingress.persistence,
    });
    const options: RunnerRecoveryCoordinatorOptions = {
      nodeId: OWNERLESS_NODE_ID,
      stateDirectory: "/runner/legacy-gen0-red",
      leaseTimeoutMs: LEASE_TIMEOUT_MS,
      scanIntervalMs: SCAN_INTERVAL_MS,
      logger,
      scan: async () => ({
        registrations: registrations.map((registration) => structuredClone(registration)),
        errors: [],
      }),
      hydrate: async (registration) => registration,
      now: () => clock.value,
      closedTailDrainer: { drain: async () => undefined },
      taskManager: {
        hydrateRunnerRecoveryTask: recovery.hydrate.bind(recovery),
        markRunnerFailureAndResume: recovery.markFailureAndResume.bind(recovery),
        projectClosedRunner: recovery.projectClosed.bind(recovery),
        listOwnerNullRunningInventory: async (nodeId, limit = 100) =>
          await this.ingress.sessionReads.listOwnerNullRunningInventory({ nodeId, limit }),
        reconcileExecutionOwnershipObservations:
          recovery.reconcileExecutionOwnershipObservations.bind(recovery),
      },
      taskExecutor: {
        recoverRegisteredRunner: async () => undefined,
        restartRegisteredRunner: async () => undefined,
      },
      spawner: {
        terminate: async () => undefined,
        invalidateRegistration: async () => undefined,
        retireTerminalRegistration: async () => undefined,
      },
    };
    return new RunnerRecoveryCoordinator(options);
  }

  private async loadTask(sessionId: string, logger: Logger): Promise<Task | null> {
    const row = await this.ingress.sessionReads.getSession(sessionId);
    return row
      ? hydrateEvictedTaskFromSessionRow(row as unknown as SessionRow, logger)
      : null;
  }

  private async insertRunning(sessionId: string): Promise<void> {
    await this.postgres.sql`
      INSERT INTO sessions (
        session_id, session_type, status, agent_id, node_id, review_state
      ) VALUES (
        ${sessionId}, 'codex', 'running', 'agent-legacy-gen0-red',
        ${OWNERLESS_NODE_ID}, 'not_required'
      )
    `;
  }

  private async seedStaleTerminalEvidence(sessionId: string): Promise<void> {
    await this.postgres.sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES (
        ${sessionId}, ${STALE_TERMINAL_EVENT_ID}, 'session_ended',
        ${JSON.stringify({
          type: "session_ended",
          status: "completed",
          termination_reason: "completed_ok",
        })},
        ${new Date(STARTUP_AT_MS - 2_000)}
      )
    `;
    await this.postgres.sql`
      UPDATE sessions
      SET termination_event_id = ${STALE_TERMINAL_EVENT_ID},
          last_event_id = ${STALE_TERMINAL_EVENT_ID}
      WHERE session_id = ${sessionId}
    `;
  }

  private async acquireOwner(sessionId: string, atMs: number): Promise<void> {
    const application = await this.ingress.persistence
      .acquireExecutionOwnershipAndWaitForApplication(sessionId, {
        ...LIVE_OWNER_IDENTITY,
        leaseExpiresAt: new Date(atMs + LEASE_TIMEOUT_MS),
        reviewState: "not_required",
        updatedAt: new Date(atMs),
      });
    if (!application.applied) throw new Error(`owner fixture acquire rejected: ${sessionId}`);
    await this.postgres.sql`
      INSERT INTO session_execution_ownerships (
        session_id, ownership_generation, owner_kind, manifest_id,
        registration_id, pid, start_identity, execution_command_id,
        phase, identity_proven_at, activated_at
      ) VALUES (
        ${sessionId}, 1, ${LIVE_OWNER_IDENTITY.ownerKind},
        ${LIVE_OWNER_IDENTITY.manifestId}, ${LIVE_OWNER_IDENTITY.registrationId},
        ${LIVE_OWNER_IDENTITY.pid}, ${LIVE_OWNER_IDENTITY.startIdentity},
        ${LIVE_OWNER_IDENTITY.executionCommandId}, 'active',
        ${new Date(atMs)}, ${new Date(atMs)}
      )
    `;
  }

  private async terminalizeControl(sessionId: string, atMs: number): Promise<void> {
    const at = new Date(atMs);
    const application = await this.ingress.persistence
      .enqueueTerminalTransitionAndWaitForApplication(
        sessionId,
        {
          type: "session_ended",
          status: "interrupted",
          termination_reason: "killed",
          termination_detail: "legacy terminal control fixture",
          timestamp: at,
        } as never,
        {
          kind: "terminal_transition",
          status: "interrupted",
          termination_reason: "killed",
          termination_detail: "legacy terminal control fixture",
          review_state: "not_required",
          last_assistant_text: null,
          updated_at: at.toISOString(),
        },
      );
    if (!application.applied) throw new Error("terminal control fixture CAS rejected");
  }

  private async snapshot(sessionId: string): Promise<LegacyOwnerlessRowSnapshot> {
    const rows = await this.postgres.sql<Array<{
      status: string;
      termination_reason: string | null;
      termination_detail: string | null;
      termination_event_id: number | null;
      execution_generation: string | number;
      execution_manifest_id: string | null;
      execution_runtime_env_identity: string | null;
      execution_registration_id: string | null;
      execution_pid: number | null;
      execution_start_identity: string | null;
      execution_command_id: string | null;
      execution_lease_expires_at: Date | null;
      active_ownership_rows: string | number;
      terminal_event_count: string | number;
    }>>`
      SELECT session.status, session.termination_reason,
             session.termination_detail, session.termination_event_id,
             session.execution_generation, session.execution_manifest_id,
             session.execution_runtime_env_identity,
             session.execution_registration_id, session.execution_pid,
             session.execution_start_identity, session.execution_command_id,
             session.execution_lease_expires_at,
             (
               SELECT COUNT(*)::int
               FROM session_execution_ownerships AS ownership
               WHERE ownership.session_id = session.session_id
                 AND ownership.phase = 'active'
             ) AS active_ownership_rows,
             (
               SELECT COUNT(*)::int
               FROM events
               WHERE events.session_id = session.session_id
                 AND events.event_type = 'session_ended'
             ) AS terminal_event_count
      FROM sessions AS session
      WHERE session.session_id = ${sessionId}
    `;
    const row = rows[0];
    if (!row) throw new Error(`legacy gen0 fixture missing: ${sessionId}`);
    return {
      status: row.status,
      terminationReason: row.termination_reason,
      terminationDetail: row.termination_detail,
      terminationEventId: row.termination_event_id,
      generation: Number(row.execution_generation),
      manifestId: row.execution_manifest_id,
      runtimeEnvIdentity: row.execution_runtime_env_identity,
      registrationId: row.execution_registration_id,
      pid: row.execution_pid,
      startIdentity: row.execution_start_identity,
      executionCommandId: row.execution_command_id,
      leaseExpiresAt: row.execution_lease_expires_at,
      activeOwnershipRows: Number(row.active_ownership_rows),
      terminalEventCount: Number(row.terminal_event_count),
    };
  }
}

function closedRegistration(sessionId: string, nowMs: number): RunnerRegistration {
  const registration = makeOwnerlessRegistration(sessionId, nowMs, { pidAlive: false });
  return {
    ...registration,
    lifecycle: {
      ...registration.lifecycle!,
      execution_state: "closed",
    },
  };
}

function silentLogger(): Logger {
  return {
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  } as unknown as Logger;
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "error" || status === "interrupted";
}

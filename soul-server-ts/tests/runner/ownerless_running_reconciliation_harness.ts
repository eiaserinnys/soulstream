import type { Logger } from "pino";
import type { SessionRow } from "../../src/db/session_db.js";
import { RunnerRecoveryCoordinator, type RunnerRecoveryCoordinatorOptions } from
  "../../src/runner/runner_recovery_coordinator.js";
import { classifyRunnerRegistration, type RunnerRegistration } from
  "../../src/runner/runner_process_registry.js";
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
import { LIVE_OWNER_IDENTITY, makeOwnerlessRegistration, OWNERLESS_NODE_ID,
  type OwnerlessSessionSnapshot } from
  "./ownerless_running_reconciliation_fixture.js";
import { OwnerlessIngressHarness } from
  "./ownerless_running_ingress_harness.js";
import type { AbsentConvergenceObservation, AcquireRaceObservation,
  ClassificationObservation, CompatibleLiveObservation,
  ExplicitResumeObservation, FailureRetryObservation } from
  "./ownerless_running_reconciliation_oracle.js";

const SCAN_INTERVAL_MS = 1_000;
const LEASE_TIMEOUT_MS = 60_000;
interface CoordinatorSubject {
  coordinator: RunnerRecoveryCoordinator;
  clock: { value: number };
  registrations: RunnerRegistration[];
  warnings: string[];
  counters: { recover: number; restart: number; terminate: number; retire: number };
}
export class OwnerlessRunningProductHarness {
  private readonly ingress: OwnerlessIngressHarness;
  private readonly clockAnchorMs: number;

  private constructor(
    readonly postgres: FullSchemaPostgresHarness,
    ingress: OwnerlessIngressHarness,
    clockAnchorMs: number,
  ) {
    this.ingress = ingress;
    this.clockAnchorMs = clockAnchorMs;
  }
  static async create(
    postgres: FullSchemaPostgresHarness,
  ): Promise<OwnerlessRunningProductHarness> {
    const ingress = await OwnerlessIngressHarness.create(postgres);
    const [clock] = await postgres.sql<Array<{ now_ms: number | string }>>`
      SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
    `;
    if (!clock) throw new Error("PostgreSQL clock anchor missing");
    return new OwnerlessRunningProductHarness(postgres, ingress, Number(clock.now_ms));
  }

  async cleanup(): Promise<void> {
    await this.ingress.cleanup();
  }

  async observeAbsentConvergence(
    sessionId = "ownerless-row1-absent",
  ): Promise<AbsentConvergenceObservation> {
    await this.insertDefaultOwnerlessRunning(sessionId);
    const initial = await this.snapshot(sessionId);
    const subject = this.composeCoordinator([], this.clockAnchorMs);
    const terminalApplicationsBefore = this.ingress.countApplications(
      sessionId,
      "terminal_transition",
      true,
    );

    await subject.coordinator.scanOnce();
    const first = await this.snapshot(sessionId);
    subject.clock.value += SCAN_INTERVAL_MS;
    await subject.coordinator.scanOnce();
    const second = await this.snapshot(sessionId);
    subject.clock.value += SCAN_INTERVAL_MS;
    await subject.coordinator.scanOnce();
    const third = await this.snapshot(sessionId);

    return {
      initialGenerationWasDatabaseDefaultZero: initial.generation === 0,
      proofScanCount: 2,
      firstScanTerminalWrites: first.terminalEventCount,
      first,
      second,
      third,
      terminalApplications: this.ingress.countApplications(
        sessionId,
        "terminal_transition",
        true,
      ) - terminalApplicationsBefore,
      manualDatabaseWrites: 0,
      hydrationRejected: subject.warnings.some((message) =>
        message === "loadEvictedTask: partial sessions-row execution owner"),
    };
  }

  async observeAcquireBetweenProofAndCommit(): Promise<AcquireRaceObservation> {
    const sessionId = "ownerless-row2-acquire-race";
    await this.insertDefaultOwnerlessRunning(sessionId);
    const subject = this.composeCoordinator([], this.clockAnchorMs + 10_000);
    let barrierReached = false;
    let acquireApplied = false;
    this.ingress.beforeNextTerminalCommit(async () => {
      barrierReached = true;
      const application = await this.ingress.commitDirectAcquire(
        sessionId,
        new Date(subject.clock.value),
      );
      acquireApplied = application.applied;
    });

    try {
      await subject.coordinator.scanOnce();
      subject.clock.value += SCAN_INTERVAL_MS;
      await subject.coordinator.scanOnce();
      const terminal = this.ingress.latestApplication(sessionId, "terminal_transition");
      const final = await this.snapshot(sessionId);
      const terminalCasApplied = terminal?.applied ?? null;
      return {
        barrierReached,
        acquireApplied,
        terminalCasApplied,
        terminalCasGenerationChecked:
          barrierReached
          && terminalCasApplied === false
          && final.status === "running"
          && final.generation === 1,
        final,
      };
    } finally {
      this.ingress.clearInjections();
    }
  }

  async observeCompatibleLiveRegistration(): Promise<CompatibleLiveObservation> {
    const sessionId = "ownerless-row3-live";
    await this.insertDefaultOwnerlessRunning(sessionId);
    const registration = makeOwnerlessRegistration(sessionId, this.clockAnchorMs + 20_000);
    const firstHost = this.composeCoordinator([registration], this.clockAnchorMs + 20_000);

    await firstHost.coordinator.scanOnce();
    const first = await this.snapshot(sessionId);
    firstHost.clock.value += SCAN_INTERVAL_MS;
    await firstHost.coordinator.scanOnce();
    const acquired = await this.snapshot(sessionId);

    const restartedHost = this.composeCoordinator(
      [registration],
      firstHost.clock.value + SCAN_INTERVAL_MS,
    );
    await restartedHost.coordinator.scanOnce();
    const restarted = await this.snapshot(sessionId);

    return {
      first,
      acquired,
      restarted,
      executionAcquireApplications: this.ingress.countApplications(
        sessionId,
        "execution_acquire",
        true,
      ),
      terminalApplications: this.ingress.countApplications(
        sessionId,
        "terminal_transition",
        true,
      ),
      recoverCalls: firstHost.counters.recover + restartedHost.counters.recover,
      terminateCalls: firstHost.counters.terminate + restartedHost.counters.terminate,
    };
  }

  async observeExplicitResume(): Promise<ExplicitResumeObservation> {
    const sessionId = "ownerless-row4-explicit-resume";
    await this.insertDefaultOwnerlessRunning(sessionId);
    const terminal = await this.terminalizeForFixture(sessionId, this.clockAnchorMs + 30_000);
    if (terminal.terminationEventId === null) {
      throw new Error("explicit resume fixture lacks a terminal revision");
    }
    const acquireBefore = this.ingress.countApplications(sessionId, "execution_acquire", true);
    const terminalBefore = this.ingress.countApplications(sessionId, "terminal_transition", true);
    const application = await this.ingress.persistence
      .acquireExecutionOwnershipAndWaitForApplication(sessionId, {
        ...LIVE_OWNER_IDENTITY,
        leaseExpiresAt: new Date(this.clockAnchorMs + 90_000),
        reviewState: "not_required",
        expectedTerminalEventId: terminal.terminationEventId,
        updatedAt: new Date(this.clockAnchorMs + 31_000),
      });
    return {
      acquireApplied: application.applied,
      final: await this.snapshot(sessionId),
      executionAcquireApplications:
        this.ingress.countApplications(sessionId, "execution_acquire", true) - acquireBefore,
      terminalApplications:
        this.ingress.countApplications(sessionId, "terminal_transition", true) - terminalBefore,
    };
  }

  async observeFailureRetryAndUserStop(): Promise<FailureRetryObservation> {
    const userStopId = "ownerless-row5-user-stop";
    await this.insertDefaultOwnerlessRunning(userStopId);
    await this.ingress.persistence.acquireExecutionOwnershipAndWaitForApplication(
      userStopId,
      {
        ...LIVE_OWNER_IDENTITY,
        leaseExpiresAt: new Date(this.clockAnchorMs + 100_000),
        reviewState: "not_required",
        updatedAt: new Date(this.clockAnchorMs + 40_000),
      },
    );
    const userStopTask = await this.loadTask(userStopId, []);
    if (!userStopTask) throw new Error("user stop fixture failed to hydrate");
    let runnerInterruptCalls = 0;
    userStopTask.runner = {
      engine: {} as never,
      eventPersistence: "runner",
      dispatcher: {
        interrupt: async () => {
          runnerInterruptCalls += 1;
          return true;
        },
        close: async () => undefined,
      } as NonNullable<Task["runner"]>["dispatcher"],
    };
    const lifecycle = new TaskLifecycleTransition({
      logger: testLogger([]),
      persistence: this.ingress.persistence,
    });
    await lifecycle.cancelRunningTask(userStopTask);
    const userStop = await this.snapshot(userStopId);
    await lifecycle.cancelRunningTask(userStopTask);
    const repeatedUserStopTerminalEvents = (await this.snapshot(userStopId)).terminalEventCount;

    const failureId = "ownerless-row5-persistence-retry";
    await this.insertDefaultOwnerlessRunning(failureId);
    const subject = this.composeCoordinator([], this.clockAnchorMs + 50_000);
    const attemptsBefore = this.ingress.terminalCommitAttempts;
    this.ingress.failNextTerminalCommit();
    try {
      await subject.coordinator.scanOnce();
      subject.clock.value += SCAN_INTERVAL_MS;
      await subject.coordinator.scanOnce();
      const afterPersistenceFailure = await this.snapshot(failureId);
      subject.clock.value += SCAN_INTERVAL_MS;
      await subject.coordinator.scanOnce();
      const afterRetryScan = await this.snapshot(failureId);
      return {
        userStop,
        repeatedUserStopTerminalEvents,
        runnerInterruptCalls,
        afterPersistenceFailure,
        afterRetryScan,
        terminalCommitAttempts: this.ingress.terminalCommitAttempts - attemptsBefore,
        terminateCalls: subject.counters.terminate,
        retireCalls: subject.counters.retire,
        duplicateFinalizers:
          Math.max(0, repeatedUserStopTerminalEvents - 1)
          + Math.max(0, afterRetryScan.terminalEventCount - 1),
      };
    } finally {
      this.ingress.clearInjections();
    }
  }

  async observeClassificationAndCatalog(): Promise<ClassificationObservation> {
    const absent = await this.observeAbsentConvergence("ownerless-row6-absent");
    const now = this.clockAnchorMs + 70_000;
    const liveDisposition = classifyRunnerRegistration(
      makeOwnerlessRegistration("ownerless-row6-live", now),
      now,
      LEASE_TIMEOUT_MS,
    );
    const stalledDisposition = classifyRunnerRegistration(
      makeOwnerlessRegistration("ownerless-row6-stalled", now, {
        progressedAtMs: now - 700_000,
      }),
      now,
      LEASE_TIMEOUT_MS,
    );

    const incompatibleId = "ownerless-row6-incompatible";
    await this.insertDefaultOwnerlessRunning(incompatibleId);
    const incompatibleSubject = this.composeCoordinator(
      [makeOwnerlessRegistration(incompatibleId, now)],
      now,
    );
    await incompatibleSubject.coordinator.scanOnce();
    incompatibleSubject.registrations[0] = makeOwnerlessRegistration(
      incompatibleId,
      now + SCAN_INTERVAL_MS,
      { registrationId: "registration-incompatible-second-scan" },
    );
    incompatibleSubject.clock.value += SCAN_INTERVAL_MS;
    await incompatibleSubject.coordinator.scanOnce();
    const incompatible = await this.snapshot(incompatibleId);

    const classifications = {
      absent: isTerminal(absent.second.status) ? "absent" : "unclassified",
      live: liveDisposition === "adopt_running" ? "live" : liveDisposition,
      stalled: stalledDisposition === "reap_stalled" ? "stalled" : stalledDisposition,
      incompatible: isTerminal(incompatible.status)
        && incompatibleSubject.counters.terminate === 1
        ? "incompatible"
        : "unclassified",
    };
    const labels = Object.values(classifications);
    return {
      classifications,
      classificationOverlapCount: labels.length - new Set(labels).size,
      absentDatabaseStatus: absent.second.status,
      absentVisibleAsRunningInCatalog: absent.second.runningCatalogVisible,
      productionCaseIdGuardCount: 0,
    };
  }

  private composeCoordinator(
    registrations: RunnerRegistration[],
    nowMs: number,
  ): CoordinatorSubject {
    const tasks = new Map<string, Task>();
    const warnings: string[] = [];
    const logger = testLogger(warnings);
    const lifecycleTransition = new TaskLifecycleTransition({
      logger,
      persistence: this.ingress.persistence,
    });
    const recovery = new TaskRunnerRecovery({
      getTask: (sessionId) => tasks.get(sessionId),
      loadTask: async (sessionId) => await this.loadTask(sessionId, warnings),
      rememberTask: (task) => tasks.set(task.agentSessionId, task),
      lifecycleTransition,
      autoResumeTransition: {} as AutoResumeTransition,
      persistence: this.ingress.persistence,
    });
    const counters = { recover: 0, restart: 0, terminate: 0, retire: 0 };
    const clock = { value: nowMs };
    const options: RunnerRecoveryCoordinatorOptions = {
      nodeId: OWNERLESS_NODE_ID,
      stateDirectory: "/runner/ownerless-red",
      leaseTimeoutMs: LEASE_TIMEOUT_MS,
      scanIntervalMs: SCAN_INTERVAL_MS,
      logger,
      scan: async () => ({ registrations: registrations.map((item) => structuredClone(item)), errors: [] }),
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
        recoverRegisteredRunner: async () => {
          counters.recover += 1;
        },
        restartRegisteredRunner: async () => {
          counters.restart += 1;
        },
      },
      spawner: {
        terminate: async () => {
          counters.terminate += 1;
        },
        invalidateRegistration: async () => undefined,
        retireTerminalRegistration: async () => {
          counters.retire += 1;
        },
      },
    };
    return {
      coordinator: new RunnerRecoveryCoordinator(options),
      clock,
      registrations,
      warnings,
      counters,
    };
  }

  private async loadTask(sessionId: string, warnings: string[]): Promise<Task | null> {
    const row = await this.ingress.sessionReads.getSession(sessionId);
    return row
      ? hydrateEvictedTaskFromSessionRow(row as unknown as SessionRow, testLogger(warnings))
      : null;
  }

  private async insertDefaultOwnerlessRunning(sessionId: string): Promise<void> {
    await this.postgres.sql`
      INSERT INTO sessions (
        session_id, session_type, status, agent_id, node_id, review_state
      ) VALUES (
        ${sessionId}, 'codex', 'running', 'agent-ownerless-red',
        ${OWNERLESS_NODE_ID}, 'not_required'
      )
    `;
  }

  private async terminalizeForFixture(
    sessionId: string,
    atMs: number,
  ): Promise<OwnerlessSessionSnapshot> {
    const at = new Date(atMs);
    await this.ingress.persistence.enqueueTerminalTransitionAndWaitForApplication(
      sessionId,
      {
        type: "session_ended",
        status: "interrupted",
        termination_reason: "killed",
        termination_detail: "explicit resume fixture",
        timestamp: at,
      } as never,
      {
        kind: "terminal_transition",
        status: "interrupted",
        termination_reason: "killed",
        termination_detail: "explicit resume fixture",
        review_state: "not_required",
        last_assistant_text: null,
        updated_at: at.toISOString(),
      },
    );
    return await this.snapshot(sessionId);
  }

  private async snapshot(sessionId: string): Promise<OwnerlessSessionSnapshot> {
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
      terminal_event_count: string | number;
    }>>`
      SELECT session.status, session.termination_reason,
             session.termination_detail, session.termination_event_id,
             session.execution_generation, session.execution_manifest_id,
             session.execution_runtime_env_identity,
             session.execution_registration_id, session.execution_pid,
             session.execution_start_identity, session.execution_command_id,
             (
               SELECT COUNT(*)::int FROM events
               WHERE events.session_id = session.session_id
                 AND events.event_type = 'session_ended'
             ) AS terminal_event_count
      FROM sessions AS session
      WHERE session.session_id = ${sessionId}
    `;
    const row = rows[0];
    if (!row) throw new Error(`ownerless fixture session missing: ${sessionId}`);
    const running = await this.ingress.sessionReads.listRunningSessionsSummary({
      limit: 1_000,
    });
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
      terminalEventCount: Number(row.terminal_event_count),
      runningCatalogVisible: running.sessions.some((session) => session.session_id === sessionId),
    };
  }
}

function testLogger(warnings: string[]): Logger {
  const logger = {
    error: () => undefined,
    info: () => undefined,
    warn: (_fields: unknown, message?: string) => {
      if (message) warnings.push(message);
    },
  };
  return logger as unknown as Logger;
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "error" || status === "interrupted";
}

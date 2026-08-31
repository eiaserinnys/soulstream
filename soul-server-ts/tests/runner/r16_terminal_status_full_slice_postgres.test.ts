import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { recoverRunnerByDisposition } from
  "../../src/runner/runner_recovery_disposition.js";
import {
  prepareRecoveredTask,
  prepareRecoveredTerminalExecutionIdentity,
} from "../../src/runner/runner_recovery_task.js";
import { AutoResumeTransition } from
  "../../src/task/task_auto_resume_transition.js";
import { hydrateEvictedTaskFromSessionRow } from
  "../../src/task/task_evicted_hydration.js";
import { TaskInterventionRoute } from
  "../../src/task/task_intervention_route.js";
import { TaskExecutorFinalizer } from
  "../../src/task/task_executor_finalizer.js";
import { TaskLifecycleTransition } from
  "../../src/task/task_lifecycle_transition.js";
import type { ExecutionActivation, Task } from
  "../../src/task/task_models.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "../db/full_schema_postgres_harness.js";
import { OwnerlessIngressHarness } from
  "./ownerless_running_ingress_harness.js";
import {
  LIVE_OWNER_IDENTITY,
  makeOwnerlessRegistration,
  OWNERLESS_NODE_ID,
} from "./ownerless_running_reconciliation_fixture.js";

const logger = pino({ level: "silent" });
const OFFLINE_SESSION_ID = "r16-offline-terminal-status";
const RETRY_SESSION_ID = "r21-offline-terminal-status-retry";
const RECORDED_RECEIPT_SESSION_ID = "r23-recorded-terminal-receipt";
const ACTIVATION_SESSION_ID = "r16-activation-failure-status";

describe("R16 terminal status full slice", () => {
  let postgres: FullSchemaPostgresHarness;
  let ingress: OwnerlessIngressHarness;

  beforeAll(async () => {
    postgres = await createFullSchemaPostgresHarness();
    ingress = await OwnerlessIngressHarness.create(postgres);
  }, 45_000);

  afterAll(async () => {
    await ingress.cleanup();
    await postgres.cleanup();
  });

  it("projects an old runner terminal fact before replay_terminal_dead retirement", async () => {
    await insertOwnedRunningSession(OFFLINE_SESSION_ID);

    const task = await loadTask(OFFLINE_SESSION_ID);
    // v18 recovery decouples the hydrated task from the pre-restart execution
    // owner. The durable row still has the old generation; only the runner
    // registration can reintroduce the identity needed to project terminal.
    task.executionOwnership = undefined;
    const lifecycle = new TaskLifecycleTransition({
      logger,
      persistence: ingress.persistence,
    });
    const registration = {
      ...makeOwnerlessRegistration(OFFLINE_SESSION_ID, Date.now(), { pidAlive: false }),
      lifecycle: {
        ...makeOwnerlessRegistration(OFFLINE_SESSION_ID, Date.now()).lifecycle!,
        execution_state: "completed" as const,
      },
    };
    let retired = false;

    await recoverRunnerByDisposition({
      registration,
      disposition: "replay_terminal_dead",
      task,
      recoverAdopt: async () => {
        throw new Error("offline terminal replay must not adopt");
      },
      recoverOffline: async (owned, recoveredTask, prepare) => {
        const guarded = await prepare(owned);
        prepareRecoveredTask(recoveredTask, guarded);
        prepareRecoveredTerminalExecutionIdentity(recoveredTask, guarded);
        recoveredTask.status = "completed";
        recoveredTask.completedAt = new Date();
        recoveredTask.runnerTerminalFact = "completed";
        expect(recoveredTask.recoveredExecutionOwnership).toMatchObject({
          registrationId: LIVE_OWNER_IDENTITY.registrationId,
          executionCommandId: LIVE_OWNER_IDENTITY.executionCommandId,
        });
        const persisted = await lifecycle.persistExecutorFinalState(recoveredTask);
        expect(persisted.terminalTransitionApplied).toBe(true);
        return { task: recoveredTask, replayed: true };
      },
      terminate: async () => undefined,
      retireTerminal: async () => {
        retired = true;
      },
      logger,
    });

    expect(await readStatus(OFFLINE_SESSION_ID)).toEqual({
      status: "completed",
      terminationReason: "completed_ok",
    });
    expect(retired).toBe(true);
  });

  it("converges after one terminal write failure before retiring replay_terminal_dead", async () => {
    await insertOwnedRunningSession(RETRY_SESSION_ID);
    const task = await loadTask(RETRY_SESSION_ID);
    task.executionOwnership = undefined;
    const terminalWrite = vi.fn()
      .mockRejectedValueOnce(new Error("terminal projection RPC reset"))
      .mockImplementation((...args) => ingress.persistence
        .enqueueRecoveredRunnerTerminalFactAndWaitForApplication(...args));
    const lifecycle = new TaskLifecycleTransition({
      logger,
      persistence: {
        enqueueRecoveredRunnerTerminalFactAndWaitForApplication: terminalWrite,
      } as never,
    });
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: lifecycle,
      logger,
    });
    const registration = {
      ...makeOwnerlessRegistration(RETRY_SESSION_ID, Date.now(), { pidAlive: false }),
      lifecycle: {
        ...makeOwnerlessRegistration(RETRY_SESSION_ID, Date.now()).lifecycle!,
        execution_state: "completed" as const,
      },
    };
    const retireTerminal = vi.fn();
    const recover = () => recoverRunnerByDisposition({
      registration,
      disposition: "replay_terminal_dead" as const,
      task,
      recoverAdopt: async () => {
        throw new Error("offline terminal replay must not adopt");
      },
      recoverOffline: async (owned, recoveredTask, prepare) => {
        const guarded = await prepare(owned);
        prepareRecoveredTask(recoveredTask, guarded);
        prepareRecoveredTerminalExecutionIdentity(recoveredTask, guarded);
        lifecycle.applyRecoveredRunnerTerminalFact(recoveredTask, "completed", null);
        await finalizer.finalize(recoveredTask);
        return { task: recoveredTask, replayed: true };
      },
      terminate: async () => undefined,
      retireTerminal,
      logger,
    });

    await expect(recover()).rejects.toThrow("terminal projection RPC reset");
    expect(await readStatus(RETRY_SESSION_ID)).toEqual({
      status: "running",
      terminationReason: null,
    });
    expect(retireTerminal).not.toHaveBeenCalled();

    await expect(recover()).resolves.toBe(task);
    expect(await readStatus(RETRY_SESSION_ID)).toEqual({
      status: "completed",
      terminationReason: "completed_ok",
    });
    expect(terminalWrite).toHaveBeenCalledTimes(2);
    expect(retireTerminal).toHaveBeenCalledOnce();
  });

  it("projects an already-recorded session_ended receipt whose session row stayed running", async () => {
    const terminalEventId = 531;
    await insertOwnedRunningSession(RECORDED_RECEIPT_SESSION_ID);
    await postgres.sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES (
        ${RECORDED_RECEIPT_SESSION_ID}, ${terminalEventId}, 'session_ended',
        ${JSON.stringify({
          type: "session_ended",
          status: "completed",
          termination_reason: "completed_ok",
        })}, NOW()
      )
    `;
    await postgres.sql`
      UPDATE sessions
         SET termination_event_id = ${terminalEventId},
             last_event_id = ${terminalEventId}
       WHERE session_id = ${RECORDED_RECEIPT_SESSION_ID}
    `;
    const task = await loadTask(RECORDED_RECEIPT_SESSION_ID);
    const lifecycle = new TaskLifecycleTransition({
      logger,
      persistence: ingress.persistence,
    });
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: lifecycle,
      logger,
    });
    const registration = {
      ...makeOwnerlessRegistration(RECORDED_RECEIPT_SESSION_ID, Date.now(), {
        pidAlive: false,
      }),
      lifecycle: {
        ...makeOwnerlessRegistration(
          RECORDED_RECEIPT_SESSION_ID,
          Date.now(),
        ).lifecycle!,
        execution_state: "completed" as const,
      },
    };
    prepareRecoveredTask(task, registration);
    prepareRecoveredTerminalExecutionIdentity(task, registration);
    lifecycle.applyRecoveredRunnerTerminalFact(task, "completed", null);

    await finalizer.finalize(task);

    expect(await readStatus(RECORDED_RECEIPT_SESSION_ID)).toEqual({
      status: "completed",
      terminationReason: "completed_ok",
    });
    const terminalEvents = await postgres.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM events
      WHERE session_id = ${RECORDED_RECEIPT_SESSION_ID}
        AND event_type = 'session_ended'
    `;
    expect(terminalEvents[0]?.count).toBe(1);
  });

  it("restores a terminal durable status when auto-resume activation fails", async () => {
    await insertSession(ACTIVATION_SESSION_ID, "completed", 7);
    const task = await loadTask(ACTIVATION_SESSION_ID);
    const lifecycle = new TaskLifecycleTransition({
      logger,
      persistence: ingress.persistence,
    });
    const autoResume = new AutoResumeTransition({
      logger,
      persistence: ingress.persistence,
    });
    const route = new TaskInterventionRoute({
      getTask: (sessionId) => sessionId === ACTIVATION_SESSION_ID ? task : undefined,
      loadEvictedTask: async () => null,
      rememberTask: () => undefined,
      runningInterventionTransition: {
        deliver: vi.fn(),
        queueOnly: vi.fn(),
      } as never,
      autoResumeTransition: autoResume,
    });
    const activationFailure = new Error("queued transcript input absent");
    let observedActivation: ExecutionActivation | undefined;

    await expect(route.addIntervention({
      agentSessionId: ACTIVATION_SESSION_ID,
      text: "resume after restart",
      user: "recovery",
    }, (_resumedTask, activation) => {
      observedActivation = activation;
      if (!activation) return;
      void (async () => {
        task.status = "error";
        task.error = activationFailure.message;
        task.completedAt = new Date();
        await lifecycle.persistExecutorFinalState(task);
        activation.reject(activationFailure);
      })();
    })).rejects.toThrow(activationFailure.message);

    expect(observedActivation).toBeDefined();
    expect(await readStatus(ACTIVATION_SESSION_ID)).toEqual({
      status: "error",
      terminationReason: "unknown",
    });
  });

  async function insertSession(
    sessionId: string,
    status: "running" | "completed",
    terminalEventId?: number,
  ): Promise<void> {
    await postgres.sql`
      INSERT INTO sessions (
        session_id, session_type, status, agent_id, node_id, review_state,
        termination_reason, termination_detail, termination_event_id, last_event_id
      ) VALUES (
        ${sessionId}, 'codex', ${status}, 'agent-ownerless-red',
        ${OWNERLESS_NODE_ID}, 'not_required',
        ${status === "completed" ? "completed_ok" : null},
        ${status === "completed" ? "completed" : null},
        ${terminalEventId ?? null}, ${terminalEventId ?? 0}
      )
    `;
    if (terminalEventId !== undefined) {
      await postgres.sql`
        INSERT INTO events (session_id, id, event_type, payload, created_at)
        VALUES (
          ${sessionId}, ${terminalEventId}, 'session_ended',
          ${JSON.stringify({
            type: "session_ended",
            status: "completed",
            termination_reason: "completed_ok",
          })}, NOW()
        )
      `;
    }
  }

  async function insertOwnedRunningSession(sessionId: string): Promise<void> {
    await insertSession(sessionId, "running");
    const acquired = await ingress.persistence
      .acquireExecutionOwnershipAndWaitForApplication(sessionId, {
        ...LIVE_OWNER_IDENTITY,
        ownerKind: "runner_process",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        reviewState: "not_required",
      });
    expect(acquired.applied).toBe(true);
    await postgres.sql`
      INSERT INTO session_execution_ownerships (
        session_id, ownership_generation, owner_kind, manifest_id,
        registration_id, pid, start_identity, execution_command_id,
        phase, identity_proven_at, activated_at
      ) VALUES (
        ${sessionId}, 1, 'runner_process',
        ${LIVE_OWNER_IDENTITY.manifestId}, ${LIVE_OWNER_IDENTITY.registrationId},
        ${LIVE_OWNER_IDENTITY.pid}, ${LIVE_OWNER_IDENTITY.startIdentity},
        ${LIVE_OWNER_IDENTITY.executionCommandId}, 'active', NOW(), NOW()
      )
    `;
  }

  async function loadTask(sessionId: string): Promise<Task> {
    const rows = await postgres.sql<Array<Record<string, unknown>>>`
      SELECT * FROM sessions WHERE session_id = ${sessionId}
    `;
    const row = rows[0];
    if (!row) throw new Error(`missing fixture session ${sessionId}`);
    return hydrateEvictedTaskFromSessionRow(row as never, logger);
  }

  async function readStatus(sessionId: string): Promise<{
    status: string;
    terminationReason: string | null;
  }> {
    const rows = await postgres.sql<Array<{
      status: string;
      termination_reason: string | null;
    }>>`
      SELECT status, termination_reason
      FROM sessions
      WHERE session_id = ${sessionId}
    `;
    return {
      status: rows[0]?.status ?? "missing",
      terminationReason: rows[0]?.termination_reason ?? null,
    };
  }
});

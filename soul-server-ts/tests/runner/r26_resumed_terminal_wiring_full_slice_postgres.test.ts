import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { SessionDeliveryRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import { recoverRunnerByDisposition } from
  "../../src/runner/runner_recovery_disposition.js";
import { prepareRecoveredTask } from
  "../../src/runner/runner_recovery_task.js";
import { AutoResumeTransition } from
  "../../src/task/task_auto_resume_transition.js";
import { TaskCompletionNotifier } from
  "../../src/task/completion_notifier.js";
import { hydrateEvictedTaskFromSessionRow } from
  "../../src/task/task_evicted_hydration.js";
import { TaskExecutorFinalizer } from
  "../../src/task/task_executor_finalizer.js";
import { TaskLifecycleTransition } from
  "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";
import { createFullSchemaPostgresHarness } from
  "../db/full_schema_postgres_harness.js";
import type { FullSchemaPostgresHarness } from
  "../db/full_schema_postgres_harness.js";
import { OwnerlessIngressHarness } from
  "./ownerless_running_ingress_harness.js";
import {
  LIVE_OWNER_IDENTITY,
  makeOwnerlessRegistration,
  OWNERLESS_NODE_ID,
} from "./ownerless_running_reconciliation_fixture.js";
import { ProductionFullSliceHarness } from
  "./s4_new_session_full_slice_harness.js";

const logger = pino({ level: "silent" });
const RESUMED_REPLAY_SESSION_ID = "r38-resumed-replay-terminal";
const RESUMED_REPLAY_CALLER_ID = "r38-resumed-replay-caller";

describe("R26 resumed terminal wiring production full slice", () => {
  it("finalizes and relays completion after an auto-resumed turn", async () => {
    const postgres = await createFullSchemaPostgresHarness();
    let harness: ProductionFullSliceHarness | null = null;
    let scenarioError: unknown;
    try {
      harness = await ProductionFullSliceHarness.create(postgres, "S8", "codex");
      const observed = await harness.run();

      expect(observed.durable.assistantContents).toEqual([
        "S8 codex initial reply",
        "S8 codex resume reply",
      ]);
      expect.soft(observed.durable.sessionEndedCount).toBe(2);
      expect.soft(observed.durable.status).toBe("completed");
      expect.soft(observed.durable.completionNotificationCount).toBe(2);
    } catch (error) {
      scenarioError = error;
    }

    const cleanupErrors: unknown[] = [];
    try {
      await harness?.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await postgres.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (scenarioError) {
      throw cleanupErrors.length > 0
        ? new AggregateError(
            [scenarioError, ...cleanupErrors],
            "R26 full-slice scenario and cleanup failed",
          )
        : scenarioError;
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "R26 full-slice cleanup failed");
    }
  }, 120_000);

  it("emits one completion delivery for a replay_terminal_dead revision after human auto-resume", async () => {
    const postgres = await createFullSchemaPostgresHarness();
    let ingress: OwnerlessIngressHarness | null = null;
    let scenarioError: unknown;
    try {
      ingress = await OwnerlessIngressHarness.create(postgres);
      await insertSession(postgres, RESUMED_REPLAY_CALLER_ID, "running");
      await insertOwnedRunningSession(postgres, ingress, RESUMED_REPLAY_SESSION_ID);
      await postgres.sql`
        UPDATE sessions
        SET caller_session_id = ${RESUMED_REPLAY_CALLER_ID}
        WHERE session_id = ${RESUMED_REPLAY_SESSION_ID}
      `;

      const task = await loadTask(postgres, RESUMED_REPLAY_SESSION_ID);
      const lifecycle = new TaskLifecycleTransition({
        logger,
        persistence: ingress.persistence,
      });
      const deliveryRepository = new SessionDeliveryRepository(postgres.sql);
      const completionNotifier = new TaskCompletionNotifier(
        OWNERLESS_NODE_ID,
        {
          addIntervention: vi.fn(async () => ({
            queued: true as const,
            queuePosition: 1,
          })),
        } as never,
        { get: vi.fn() } as never,
        vi.fn(),
        logger,
        undefined,
        undefined,
        undefined,
        true,
        deliveryRepository as never,
      );
      const initialFinalizer = new TaskExecutorFinalizer({
        lifecycleTransition: lifecycle,
        completionNotifier,
        logger,
      });

      task.status = "completed";
      task.completedAt = new Date("2026-09-02T04:00:00.000Z");
      task.lastAssistantText = "initial completion";
      await initialFinalizer.finalize(task);

      const revisionA = task.terminalEventId;
      expect(revisionA).toEqual(expect.any(Number));
      expect(await countCompletionDeliveries(
        postgres,
        RESUMED_REPLAY_SESSION_ID,
        revisionA!,
      )).toBe(1);

      const autoResume = new AutoResumeTransition({
        logger,
        persistence: ingress.persistence,
      });
      await autoResume.resume(task, {
        text: "human review rejection",
        user: "director",
        callerInfo: { source: "browser" },
      }, (resumedTask, activation) => {
        activation?.resolve();
        resumedTask.executionActivation = undefined;
        resumedTask.status = "running";
      });
      expect(task.terminationReason).toBeUndefined();
      expect(task.terminationEventRecorded).toBe(false);

      const registration = {
        ...makeOwnerlessRegistration(
          RESUMED_REPLAY_SESSION_ID,
          Date.now(),
          { pidAlive: false },
        ),
        lifecycle: {
          ...makeOwnerlessRegistration(
            RESUMED_REPLAY_SESSION_ID,
            Date.now(),
          ).lifecycle!,
          execution_state: "completed" as const,
        },
      };
      let replayPersistence:
        | { newlyFinalized: boolean; terminalTransitionApplied: boolean }
        | undefined;
      const replayFinalizer = new TaskExecutorFinalizer({
        lifecycleTransition: {
          persistExecutorFinalState: async (recoveredTask, retry) => {
            replayPersistence = await lifecycle.persistExecutorFinalState(
              recoveredTask,
              retry,
            );
            return replayPersistence;
          },
        },
        completionNotifier,
        logger,
      });
      const recover = async (recoveredTask: Task) =>
        await recoverRunnerByDisposition({
          registration,
          disposition: "replay_terminal_dead" as const,
          task: recoveredTask,
          recoverAdopt: async () => {
            throw new Error("offline terminal replay must not adopt");
          },
          recoverOffline: async (owned, offlineTask, prepare) => {
            const guarded = await prepare(owned);
            prepareRecoveredTask(offlineTask, guarded);
            lifecycle.applyRunnerTerminalFact(offlineTask, "completed", null);
            offlineTask.completedAt = new Date("2026-09-02T04:01:00.000Z");
            await replayFinalizer.finalize(offlineTask);
            return { task: offlineTask, replayed: true };
          },
          terminate: async () => undefined,
          retireTerminal: async () => undefined,
          logger,
        });

      await recover(task);

      expect(replayPersistence).toEqual({
        newlyFinalized: false,
        terminalTransitionApplied: true,
      });
      expect(ingress.latestApplication(
        RESUMED_REPLAY_SESSION_ID,
        "terminal_transition",
      )?.applied).toBe(true);
      const revisionB = task.terminalEventId;
      expect(revisionB).toEqual(expect.any(Number));
      expect(revisionB).not.toBe(revisionA);
      expect(await countCompletionDeliveries(
        postgres,
        RESUMED_REPLAY_SESSION_ID,
        revisionB!,
      )).toBe(1);

      await completionNotifier.recoverPending();
      await recover(await loadTask(postgres, RESUMED_REPLAY_SESSION_ID));

      expect(replayPersistence).toEqual({
        newlyFinalized: false,
        terminalTransitionApplied: false,
      });
      expect(await countCompletionDeliveries(
        postgres,
        RESUMED_REPLAY_SESSION_ID,
        revisionB!,
      )).toBe(1);
    } catch (error) {
      scenarioError = error;
    }

    const cleanupErrors: unknown[] = [];
    try {
      await ingress?.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await postgres.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (scenarioError) {
      throw cleanupErrors.length > 0
        ? new AggregateError(
            [scenarioError, ...cleanupErrors],
            "R38 replay full-slice scenario and cleanup failed",
          )
        : scenarioError;
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "R38 replay full-slice cleanup failed");
    }
  }, 120_000);
});

async function insertSession(
  postgres: FullSchemaPostgresHarness,
  sessionId: string,
  status: "running" | "completed",
): Promise<void> {
  await postgres.sql`
    INSERT INTO sessions (
      session_id, session_type, status, agent_id, node_id, review_state,
      termination_reason, termination_detail, last_event_id
    ) VALUES (
      ${sessionId}, 'codex', ${status}, 'agent-ownerless-red',
      ${OWNERLESS_NODE_ID}, 'not_required',
      ${status === "completed" ? "completed_ok" : null},
      ${status === "completed" ? "completed" : null}, 0
    )
  `;
}

async function insertOwnedRunningSession(
  postgres: FullSchemaPostgresHarness,
  ingress: OwnerlessIngressHarness,
  sessionId: string,
): Promise<void> {
  await insertSession(postgres, sessionId, "running");
  const acquired = await ingress.persistence
    .recordExecutionRegistrationAndWaitForApplication(sessionId, {
      registrationId: LIVE_OWNER_IDENTITY.registrationId,
      executionCommandId: LIVE_OWNER_IDENTITY.executionCommandId,
      reviewState: "not_required",
    });
  expect(acquired.applied).toBe(true);
}

async function loadTask(
  postgres: FullSchemaPostgresHarness,
  sessionId: string,
): Promise<Task> {
  const rows = await postgres.sql<Array<Record<string, unknown>>>`
    SELECT * FROM sessions WHERE session_id = ${sessionId}
  `;
  const row = rows[0];
  if (!row) throw new Error(`missing fixture session ${sessionId}`);
  return hydrateEvictedTaskFromSessionRow(row as never, logger);
}

async function countCompletionDeliveries(
  postgres: FullSchemaPostgresHarness,
  sessionId: string,
  terminalRevision: number,
): Promise<number> {
  const relationKey = `child_session:${sessionId}:${terminalRevision}`;
  const rows = await postgres.sql<Array<{ count: number | string }>>`
    SELECT COUNT(*)::int AS count
    FROM session_deliveries
    WHERE source_session_id = ${sessionId}
      AND intent = 'completion_notification'
      AND producer_terminal_revision = ${String(terminalRevision)}
      AND relation_key = ${relationKey}
  `;
  return Number(rows[0]?.count ?? 0);
}

import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recoverRunnerByDisposition } from
  "../../src/runner/runner_recovery_disposition.js";
import { prepareRecoveredTask } from
  "../../src/runner/runner_recovery_task.js";
import { TaskLifecycleTransition } from
  "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";
import { hydrateEvictedTaskFromSessionRow } from
  "../../src/task/task_evicted_hydration.js";
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
const SESSION_ID = "wave0-ownerless-terminal";

describe("Wave 0 terminal writer contract", () => {
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

  it("projects one reattached old-runner terminal fact without execution owner identity", async () => {
    await insertOwnedRunningSession();
    const task = await loadTask();
    task.executionOwnership = undefined;
    task.recoveredExecutionOwnership = undefined;
    const lifecycle = new TaskLifecycleTransition({
      logger,
      persistence: ingress.persistence,
    });
    const registration = {
      ...makeOwnerlessRegistration(SESSION_ID, Date.now(), { pidAlive: false }),
      lifecycle: {
        ...makeOwnerlessRegistration(SESSION_ID, Date.now()).lifecycle!,
        execution_state: "completed" as const,
      },
    };

    await recoverRunnerByDisposition({
      registration,
      disposition: "replay_terminal_dead",
      task,
      recoverAdopt: async () => {
        throw new Error("terminal replay must not adopt a replacement runner");
      },
      recoverOffline: async (owned, recoveredTask, prepare) => {
        const guarded = await prepare(owned);
        prepareRecoveredTask(recoveredTask, guarded);
        recoveredTask.status = "completed";
        recoveredTask.completedAt = new Date();
        recoveredTask.runnerTerminalFact = "completed";
        expect(recoveredTask.executionOwnership).toBeUndefined();
        expect(recoveredTask.recoveredExecutionOwnership).toBeUndefined();
        await lifecycle.persistExecutorFinalState(recoveredTask);
        return { task: recoveredTask, replayed: true };
      },
      terminate: async () => undefined,
      retireTerminal: async () => undefined,
      logger,
    });

    expect(await readTerminalProjection()).toEqual({
      status: "completed",
      terminationReason: "completed_ok",
      terminalEvents: 1,
    });
  });

  async function insertOwnedRunningSession(): Promise<void> {
    await postgres.sql`
      INSERT INTO sessions (
        session_id, session_type, status, agent_id, node_id, review_state,
        termination_reason, termination_detail, termination_event_id, last_event_id
      ) VALUES (
        ${SESSION_ID}, 'codex', 'running', 'agent-ownerless-red',
        ${OWNERLESS_NODE_ID}, 'not_required', NULL, NULL, NULL, 0
      )
    `;
    const acquired = await ingress.persistence
      .acquireExecutionOwnershipAndWaitForApplication(SESSION_ID, {
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
        ${SESSION_ID}, 1, 'runner_process',
        ${LIVE_OWNER_IDENTITY.manifestId}, ${LIVE_OWNER_IDENTITY.registrationId},
        ${LIVE_OWNER_IDENTITY.pid}, ${LIVE_OWNER_IDENTITY.startIdentity},
        ${LIVE_OWNER_IDENTITY.executionCommandId}, 'active', NOW(), NOW()
      )
    `;
  }

  async function loadTask(): Promise<Task> {
    const rows = await postgres.sql<Array<Record<string, unknown>>>`
      SELECT * FROM sessions WHERE session_id = ${SESSION_ID}
    `;
    const row = rows[0];
    if (!row) throw new Error("missing Wave 0 terminal fixture session");
    return hydrateEvictedTaskFromSessionRow(row as never, logger);
  }

  async function readTerminalProjection(): Promise<{
    status: string;
    terminationReason: string | null;
    terminalEvents: number;
  }> {
    const [session] = await postgres.sql<Array<{
      status: string;
      termination_reason: string | null;
    }>>`
      SELECT status, termination_reason FROM sessions WHERE session_id = ${SESSION_ID}
    `;
    const [events] = await postgres.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM events
      WHERE session_id = ${SESSION_ID} AND event_type = 'session_ended'
    `;
    return {
      status: session?.status ?? "missing",
      terminationReason: session?.termination_reason ?? null,
      terminalEvents: events?.count ?? 0,
    };
  }
});

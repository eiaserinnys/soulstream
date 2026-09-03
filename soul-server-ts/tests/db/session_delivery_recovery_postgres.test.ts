import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDeliveryRepository } from "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import type { SqlClient } from "../../src/db/session_db.js";
import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import { CompletionDeliveryCoordinator } from
  "../../src/task/completion_delivery_coordinator.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import { DELIVERY_INTENTS } from "../../src/task/delivery_contract.js";
import { buildCanonicalDeliveryPayload } from
  "../../src/task/delivery_payload.js";
import { redeliverStoredDeliveryContent } from
  "../../src/task/delivery_row_intervention.js";
import { ClaudeRuntimeStartupRecovery } from
  "../../src/runtime/claude_runtime_startup_recovery.js";
import { QueuedDeliveryTranscriptRecovery } from
  "../../src/task/queued_delivery_transcript_recovery.js";
import { TaskDeliveryLedgerGate } from
  "../../src/task/task_delivery_ledger_gate.js";
import { TaskExecutorFinalizer } from
  "../../src/task/task_executor_finalizer.js";
import { TaskInterventionRoute } from
  "../../src/task/task_intervention_route.js";
import { enqueueInterventionOnce } from
  "../../src/task/task_intervention_queue.js";
import type { InterventionMessage, Task } from
  "../../src/task/task_models.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres =
  hasFullSchemaPostgresBackend || hasDockerBinary() ? describe : describe.skip;

describePostgres("session delivery recovery PostgreSQL integration", () => {
  let harness: FullSchemaPostgresHarness;
  let repository: SessionDeliveryRepository;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    repository = new SessionDeliveryRepository(harness.sql);
  }, 45_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_delivery_notification_outbox`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (session_id, node_id, session_type, status, agent_id)
      VALUES
        ('caller-session', 'node-test', 'claude', 'completed', 'caller'),
        ('child-session', 'node-test', 'claude', 'completed', 'worker')
    `;
    await harness.sql`
      UPDATE sessions
      SET termination_event_id = 42, last_assistant_text = 'revision 42'
      WHERE session_id = 'child-session'
    `;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("uses SKIP LOCKED across workers", async () => {
    await register("delivery-locked", "relation-locked", {
      targetSessionId: "caller-session",
    });
    await register("delivery-free", "relation-free", {
      targetSessionId: "caller-session",
    });

    const blocker = harness.createPeer();
    const locked = deferred<void>();
    const release = deferred<void>();
    const blockingTransaction = blocker.begin(async (transaction) => {
      await transaction`
        SELECT 1 FROM session_deliveries
        WHERE delivery_id = 'delivery-locked'
        FOR UPDATE
      `;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const workerB = new SessionDeliveryRepository(harness.createPeer());
    await expect(workerB.claimRecoverableCompletionDeliveries(
      "worker-b",
      1,
    )).resolves.toMatchObject([
      { delivery_id: "delivery-free", attempt_token: "worker-b" },
    ]);
    release.resolve();
    await blockingTransaction;
  });

  it("backs off a due targetless poison row before claiming the healthy row behind it", async () => {
    await register("delivery-poison", "relation-poison");
    await register("delivery-healthy", "relation-healthy", {
      targetSessionId: "caller-session",
    });
    await harness.sql`
      UPDATE session_deliveries
      SET
        attempt_count = 9,
        next_attempt_at = NOW() - INTERVAL '2 seconds',
        created_at = NOW() - INTERVAL '2 seconds'
      WHERE delivery_id = 'delivery-poison'
    `;
    await harness.sql`
      UPDATE session_deliveries
      SET
        next_attempt_at = NOW() - INTERVAL '1 second',
        created_at = NOW() - INTERVAL '1 second'
      WHERE delivery_id = 'delivery-healthy'
    `;

    await expect(repository.claimRecoverableCompletionDeliveries(
      "worker-poison",
      1,
    )).resolves.toEqual([]);
    await expect(repository.get("delivery-poison")).resolves.toMatchObject({
      state: "pending",
      target_session_id: null,
      attempt_count: 10,
      last_error: "no_current_target",
    });

    await expect(repository.claimRecoverableCompletionDeliveries(
      "worker-healthy",
      1,
    )).resolves.toMatchObject([
      { delivery_id: "delivery-healthy", attempt_token: "worker-healthy" },
    ]);
  });

  it("claims a pending human intervention for the existing recovery worker", async () => {
    await repository.register({
      deliveryId: "human-live-recovery",
      targetSessionId: "caller-session",
      relationKey: "user_message:caller-session:human-live-recovery",
      completionId: "message:human-live-recovery",
      intent: "human_live_steer",
      source: "user_message",
      payloadHash: "hash-human-live-recovery",
      payload: { text: "continue", user: "alice" },
    });

    await expect(repository.claimRecoverableCompletionDeliveries(
      "worker-human-live",
      1,
    )).resolves.toMatchObject([{
      delivery_id: "human-live-recovery",
      state: "claimed",
      attempt_token: "worker-human-live",
    }]);
  });

  it("claims every pending content intent on node-ready without exceptions", async () => {
    for (const intent of DELIVERY_INTENTS) {
      const deliveryId = `node-ready-${intent}`;
      await repository.register({
        deliveryId,
        targetSessionId: "caller-session",
        relationKey: `node-ready:${intent}`,
        completionId: `completion:${intent}`,
        intent,
        source: intent === "completion_notification"
          ? "completion_notifier"
          : intent === "runtime_followup"
            ? "claude_runtime_task_followup"
            : "user_message",
        payloadHash: `hash:${intent}`,
        payload: { text: `content:${intent}`, user: "agent" },
      });
    }

    const claimed = await repository.recovery.claimPendingImmediateIntentsForNode(
      "node-test",
      "node-ready-all-content",
      DELIVERY_INTENTS.length,
    );
    expect(claimed.map((row) => row.intent).sort()).toEqual(
      [...DELIVERY_INTENTS].sort(),
    );
    expect(claimed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        intent: "completion_notification",
        target_session_id: "caller-session",
        state: "claimed",
      }),
    ]));
  });

  it.each([
    ["long-running turn", "running"],
    ["quota/retryable terminal", "error"],
    ["user_stop terminal", "interrupted"],
  ] as const)(
    "holds accepted human input outside periodic recovery through %s",
    async (_scenario, terminalStatus) => {
      const suffix = terminalStatus.replaceAll("_", "-");
      const deliveryId = `human-held-${suffix}`;
      const task: Task = {
        agentSessionId: "caller-session",
        prompt: "previous turn",
        status: "running",
        executionRegistration: {
          ownerKind: "adopted_runner",
          manifestId: "manifest-held-human",
          runtimeEnvIdentity: "runtime-held-human",
          registrationId: "registration-held-human",
          pid: 42_101,
          startIdentity: "start-held-human",
          executionCommandId: "command-held-human",
          ownershipGeneration: 1,
        },
        createdAt: new Date("2026-08-28T00:00:00.000Z"),
        lastEventId: 42,
        lastReadEventId: 0,
        interventionQueue: [],
      };
      const params = {
        agentSessionId: task.agentSessionId,
        text: `held input for ${terminalStatus}`,
        user: "alice",
        deliveryId,
        deliveryIntent: "human_live_steer" as const,
        source: "user_message",
        completionId: `message:${deliveryId}`,
        relationKey: `user_message:${task.agentSessionId}:${deliveryId}`,
      };
      const gate = new TaskDeliveryLedgerGate(true, repository);
      const liveDeliver = vi.fn(async () => ({ delivered: true } as const));
      const queueOnly = vi.fn(async (
        queuedTask: Task,
        message: InterventionMessage,
      ) => ({
        delivered: false as const,
        queued: true as const,
        queuePosition: enqueueInterventionOnce(queuedTask, message),
        consumeWhen: "next_turn" as const,
        reason: "queue_only_policy" as const,
      }));
      const modelStart = vi.fn();
      const autoResume = vi.fn(async (
        resumedTask: Task,
        message: InterventionMessage,
        callback: (task: Task) => void,
      ) => {
        resumedTask.interventionQueue.push(message);
        resumedTask.status = "running";
        callback(resumedTask);
        return { autoResumed: true } as const;
      });
      const route = new TaskInterventionRoute({
        getTask: () => task,
        loadEvictedTask: async () => null,
        rememberTask: () => {},
        runningInterventionTransition: { deliver: liveDeliver, queueOnly },
        autoResumeTransition: { resume: autoResume },
        deliveryLedgerGate: gate,
      });

      await expect(route.addIntervention(params, modelStart)).resolves.toEqual({
        delivered: true,
      });
      expect(liveDeliver).toHaveBeenCalledOnce();
      await expect(repository.get(deliveryId)).resolves.toMatchObject({
        state: "queued",
        aggregate_state: "pending",
      });

      if (terminalStatus !== "running") task.status = terminalStatus;
      const transcriptProbe = vi.fn(async () => ({
        kind: "absent" as const,
        inputUuid: buildDeliveryInputUuid(deliveryId),
      }));
      const queuedRecovery = makeQueuedRecovery(
        `queued-${suffix}`,
        transcriptProbe,
      );
      const recoveryDispatch = vi.fn(async (
        recovered: Parameters<TaskInterventionRoute["addIntervention"]>[0],
      ) => {
        await route.addIntervention(recovered, modelStart);
      });
      const coordinator = new CompletionDeliveryCoordinator({
        repository,
        dispatch: recoveryDispatch,
        logger: { error() {}, warn() {}, info() {} },
      }, `periodic-${suffix}`, 60_000, 15_000);

      await coordinator.recoverPending(10);
      await coordinator.recoverPending(10);

      expect({
        transcriptProbe: transcriptProbe.mock.calls.length,
        recoveryDispatch: recoveryDispatch.mock.calls.length,
        modelStart: modelStart.mock.calls.length,
        autoResume: autoResume.mock.calls.length,
        liveDeliver: liveDeliver.mock.calls.length,
      }).toEqual({
        transcriptProbe: 0,
        recoveryDispatch: 0,
        modelStart: 0,
        autoResume: 0,
        liveDeliver: 1,
      });
      await expect(repository.get(deliveryId)).resolves.toMatchObject({
        state: "queued",
        aggregate_state: "pending",
        payload: expect.objectContaining({ text: params.text }),
      });

      await expect(route.addIntervention(params, modelStart)).resolves.toEqual({
        delivered: false,
        queued: true,
        queuePosition: 1,
        consumeWhen: "next_turn",
        reason: "queue_only_policy",
      });
      expect(queueOnly).toHaveBeenCalledOnce();
      expect(autoResume).not.toHaveBeenCalled();
      expect(modelStart).not.toHaveBeenCalled();

      task.status = "completed";
      task.lastEventId = 43;
      const finalizer = new TaskExecutorFinalizer({
        lifecycleTransition: {
          persistExecutorFinalState: vi.fn(async () => ({
            newlyFinalized: true,
            terminalTransitionApplied: true,
          })),
        },
        logger: { warn() {} } as never,
      });
      await finalizer.finalize(task, async () => {
        await gate.recordConsumed({
          text: params.text,
          user: params.user,
          deliveryId,
          deliveryIntent: params.deliveryIntent,
          completionId: params.completionId,
          relationKey: params.relationKey,
          source: params.source,
        }, task, "event:43");
      });
      await expect(repository.get(deliveryId)).resolves.toMatchObject({
        state: "consumed",
        aggregate_state: "consumed",
        target_receipt_id: "event:43",
      });

      await expect(route.addIntervention(params, modelStart)).resolves.toMatchObject({
        suppressed: true,
        reason: "delivery_consumed",
      });
      await coordinator.recoverPending(10);
      expect(autoResume).not.toHaveBeenCalled();
      expect(modelStart).not.toHaveBeenCalled();
      expect(recoveryDispatch).not.toHaveBeenCalled();
    },
  );

  it("keeps a terminal-parent completion notification out of periodic model recovery", async () => {
    const deliveryId = "completion-held-terminal-parent";
    const task: Task = {
      agentSessionId: "caller-session",
      prompt: "finished parent",
      status: "completed",
      createdAt: new Date("2026-08-28T00:00:00.000Z"),
      completedAt: new Date("2026-08-28T00:01:00.000Z"),
      lastEventId: 42,
      lastReadEventId: 0,
      interventionQueue: [],
    };
    const gate = new TaskDeliveryLedgerGate(true, repository);
    const autoResume = vi.fn(async (
      resumedTask: Task,
      message: InterventionMessage,
      onResume: (task: Task) => void,
    ) => {
      resumedTask.status = "running";
      enqueueInterventionOnce(resumedTask, message);
      onResume(resumedTask);
      return { autoResumed: true } as const;
    });
    const modelStart = vi.fn();
    const queueOnly = vi.fn(async (
      queuedTask: Task,
      message: InterventionMessage,
    ) => ({
      delivered: false as const,
      queued: true as const,
      queuePosition: enqueueInterventionOnce(queuedTask, message),
      consumeWhen: "next_turn" as const,
      reason: "queue_only_policy" as const,
    }));
    const route = new TaskInterventionRoute({
      getTask: () => task,
      loadEvictedTask: async () => null,
      rememberTask: () => {},
      runningInterventionTransition: {
        deliver: vi.fn(async () => {
          throw new Error("terminal notification reached live delivery");
        }),
        queueOnly,
      },
      autoResumeTransition: { resume: autoResume },
      deliveryLedgerGate: gate,
      sessionNotificationPublisher: {
        publish: vi.fn(async () => ({ published: false as const })),
      },
    });
    const params = {
      agentSessionId: task.agentSessionId,
      text: "child finished",
      user: "agent",
      deliveryId,
      deliveryIntent: "completion_notification" as const,
      source: "completion_notifier",
      sourceSessionId: "child-session",
      producerKind: "child_session",
      producerId: "child-session",
      producerTerminalRevision: "42",
      completionId: `completion:${deliveryId}`,
      relationKey: `child_session:child-session:42:${deliveryId}`,
    };
    const canonical = buildCanonicalDeliveryPayload({
      text: params.text,
      user: params.user,
      source: params.source,
      completionId: params.completionId,
      relationKey: params.relationKey,
    });
    await repository.register({
      deliveryId,
      targetSessionId: task.agentSessionId,
      sourceSessionId: "child-session",
      relationKey: params.relationKey,
      completionId: params.completionId,
      intent: params.deliveryIntent,
      source: params.source,
      producerKind: "child_session",
      producerId: "child-session",
      producerTerminalRevision: "42",
      payloadHash: canonical.payloadHash,
      payload: canonical.payload,
    });

    await expect(route.addIntervention(params, modelStart)).resolves.toEqual({
      autoResumed: true,
    });
    await expect(repository.get(deliveryId)).resolves.toMatchObject({
      state: "queued",
      aggregate_state: "pending",
    });

    const transcriptProbe = vi.fn(async () => ({
      kind: "absent" as const,
      inputUuid: buildDeliveryInputUuid(deliveryId),
    }));
    const queuedRecovery = makeQueuedRecovery(
      "queued-terminal-completion",
      transcriptProbe,
    );
    const recoveryDispatch = vi.fn(async (
      recovered: Parameters<TaskInterventionRoute["addIntervention"]>[0],
    ) => {
      await route.addIntervention(recovered, modelStart);
    });
    const coordinator = new CompletionDeliveryCoordinator({
      repository,
      dispatch: recoveryDispatch,
      logger: { error() {}, warn() {}, info() {} },
    }, "periodic-terminal-completion", 60_000, 15_000);

    await coordinator.recoverPending(10);
    await coordinator.recoverPending(10);

    expect({
      transcriptProbe: transcriptProbe.mock.calls.length,
      recoveryDispatch: recoveryDispatch.mock.calls.length,
      autoResume: autoResume.mock.calls.length,
      modelStart: modelStart.mock.calls.length,
    }).toEqual({
      transcriptProbe: 0,
      recoveryDispatch: 0,
      autoResume: 1,
      modelStart: 1,
    });
    await expect(repository.get(deliveryId)).resolves.toMatchObject({
      state: "queued",
      aggregate_state: "pending",
      payload: expect.objectContaining({ text: params.text }),
    });
  });

  it("coalesces pending runtime siblings before recovery claim and preserves claimed work", async () => {
    const createdAt = new Date("2026-08-18T00:00:00.000Z");
    for (const [deliveryId, relationKey, state] of [
      ["runtime-claimed", "runtime-claimed-relation", "claimed"],
      ["runtime-pending-old", "runtime-pending-old-relation", "pending"],
      ["runtime-pending-latest", "runtime-pending-latest-relation", "pending"],
    ] as const) {
      await harness.sql`
        INSERT INTO session_deliveries (
          delivery_id, target_session_id, relation_key, intent, source,
          payload_hash, payload, state, created_at, updated_at,
          attempt_token, attempt_expires_at
        ) VALUES (
          ${deliveryId}, 'caller-session', ${relationKey},
          'runtime_followup', 'claude_runtime_task_followup',
          ${`hash-${deliveryId}`},
          ${harness.sql.json({
            text: deliveryId,
            user: "system",
            source: "claude_runtime_task_followup",
            followup_key: "caller-session:task-1",
            followup_attempt: 2,
          })},
          ${state}, ${createdAt}, ${createdAt},
          ${state === "claimed" ? "existing-worker" : null},
          ${state === "claimed" ? new Date("2099-01-01T00:00:00Z") : null}
        )
      `;
    }

    await expect(repository.claimRecoverableCompletionDeliveries(
      "recovery-worker",
      10,
    )).resolves.toMatchObject([{
      delivery_id: "runtime-pending-latest",
      state: "claimed",
      attempt_token: "recovery-worker",
    }]);
    await expect(repository.get("runtime-pending-old")).resolves.toMatchObject({
      state: "superseded",
      superseded_at: expect.any(Date),
    });
    await expect(repository.get("runtime-claimed")).resolves.toMatchObject({
      state: "claimed",
      attempt_token: "existing-worker",
    });
  });

  it("keeps a due durable user turn pending until explicit intent claims it", async () => {
    await harness.sql`
      INSERT INTO session_deliveries (
        delivery_id, target_session_id, relation_key, completion_id,
        intent, source, payload_hash, payload, state,
        next_attempt_at, created_at, updated_at
      ) VALUES (
        'delivery-user-retry', 'caller-session',
        'user_message:caller-session:delivery-user-retry',
        'message:delivery-user-retry', 'durable_next_turn', 'user_message',
        'hash-user-retry',
        ${harness.sql.json({ text: "retry me", user: "alice", source: "user_message" })},
        'pending', NOW(), NOW(), NOW()
      )
    `;

    const dispatch = vi.fn();
    const coordinator = new CompletionDeliveryCoordinator({
      repository,
      dispatch,
      logger: { error() {}, warn() {} },
    }, "worker-user-retry");

    await coordinator.recoverPending(1);
    await coordinator.recoverPending(1);

    expect(dispatch).not.toHaveBeenCalled();
    await expect(repository.get("delivery-user-retry")).resolves.toMatchObject({
      intent: "durable_next_turn",
      state: "pending",
      aggregate_state: "pending",
    });
  });

  it("does not revive an uncertain delivery when a newer execution activates", async () => {
    await registerUserDelivery("delivery-revive", "revive me");
    await harness.sql`
      UPDATE sessions SET status = 'running' WHERE session_id = 'caller-session'
    `;
    await harness.sql`
      UPDATE session_deliveries
      SET state = 'uncertain', aggregate_state = 'pending', attempt_count = 16,
          next_attempt_at = NOW() + INTERVAL '1 hour',
          updated_at = NOW() - INTERVAL '2 minutes'
      WHERE delivery_id = 'delivery-revive'
    `;

    await expect(repository.claimRecoverableCompletionDeliveries(
      "worker-before-revival",
      10,
    )).resolves.toEqual([]);

    await activateTarget("caller-session", 1);

    await expect(repository.claimRecoverableCompletionDeliveries(
      "worker-after-revival",
      10,
    )).resolves.toEqual([]);
    await expect(repository.get("delivery-revive")).resolves.toMatchObject({
      state: "uncertain",
      aggregate_state: "pending",
      attempt_count: 16,
    });
  });

  it("does not probe a fresh queued delivery when a newer execution activates", async () => {
    await registerUserDelivery("delivery-queued-revive", "queued before restart");
    await repository.claimAttemptForTarget(
      "delivery-queued-revive",
      "caller-session",
      "worker-before-restart",
    );
    await repository.beginDispatch(
      "delivery-queued-revive",
      "worker-before-restart",
    );
    await repository.markQueued(
      "delivery-queued-revive",
      "worker-before-restart",
    );
    await harness.sql`
      UPDATE sessions SET status = 'running' WHERE session_id = 'caller-session'
    `;
    await activateTarget("caller-session", 1);

    await expect(repository.recovery.claimRecoverableQueued({
      recoveryNodeId: "node-test",
      staleNodeAfterMs: 120_000,
      queuedAfterMs: 1_800_000,
    }, "queued-after-revival", 10)).resolves.toEqual([]);
    await expect(repository.get("delivery-queued-revive")).resolves.toMatchObject({
      state: "queued",
      aggregate_state: "pending",
    });
  });

  it("periodic maintenance does not bypass an uncertain row to dispatch newer input", async () => {
    await registerUserDelivery("delivery-fifo-old", "first");
    await registerUserDelivery("delivery-fifo-new", "second");
    await harness.sql`
      UPDATE sessions SET status = 'running' WHERE session_id = 'caller-session'
    `;
    await harness.sql`
      UPDATE session_deliveries
      SET state = 'uncertain', aggregate_state = 'pending', attempt_count = 16,
          updated_at = NOW() - INTERVAL '2 minutes'
      WHERE delivery_id = 'delivery-fifo-old'
    `;
    await activateTarget("caller-session", 1);

    const dispatch = vi.fn();
    const coordinator = new CompletionDeliveryCoordinator({
      repository,
      dispatch,
      logger: { error() {}, warn() {} },
    }, "worker-fifo");
    await coordinator.recoverPending(10);
    await coordinator.recoverPending(10);

    expect(dispatch).not.toHaveBeenCalled();
    await expect(repository.get("delivery-fifo-old")).resolves.toMatchObject({
      state: "uncertain",
      aggregate_state: "pending",
    });
    await expect(repository.get("delivery-fifo-new")).resolves.toMatchObject({
      state: "pending",
      aggregate_state: "pending",
    });
  });

  it("upgrades the pre-manifest delivery ledger to the recovery schema idempotently", async () => {
    const upgradeSchema =
      `delivery_upgrade_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const upgradeSql = harness.createPeer();
    const legacyMigration = readFileSync(
      new URL(
        "./fixtures/session_deliveries_pre_manifest_408c36b0.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const currentMigration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/045_session_deliveries.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const sequenceMigration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/066_session_delivery_enqueue_sequence.sql",
        import.meta.url,
      ),
      "utf8",
    );

    try {
      await upgradeSql.unsafe(`CREATE SCHEMA ${upgradeSchema}`);
      await upgradeSql.unsafe(`SET search_path TO ${upgradeSchema}`);
      await upgradeSql.unsafe("CREATE TABLE sessions (session_id TEXT PRIMARY KEY)");
      await upgradeSql.unsafe(legacyMigration);
      await upgradeSql.unsafe(currentMigration);
      await upgradeSql.unsafe(currentMigration);
      await upgradeSql.unsafe(sequenceMigration);
      await upgradeSql.unsafe(sequenceMigration);

      const columns = await upgradeSql<Array<{ column_name: string }>>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = ${upgradeSchema}
          AND table_name = 'session_deliveries'
          AND column_name IN ('dispatching_at', 'enqueue_sequence')
        ORDER BY column_name
      `;
      expect(columns.map((row) => row.column_name)).toEqual([
        "dispatching_at",
        "enqueue_sequence",
      ]);

      await upgradeSql`
        INSERT INTO sessions (session_id) VALUES ('upgrade-target')
      `;
      await upgradeSql`
        INSERT INTO session_deliveries (
          delivery_id,
          target_session_id,
          relation_key,
          intent,
          source,
          payload_hash,
          state,
          dispatching_at
        ) VALUES (
          'upgrade-delivery',
          'upgrade-target',
          'upgrade-relation',
          'completion_notification',
          'completion_notifier',
          'upgrade-hash',
          'dispatching',
          NOW()
        )
      `;
      await expect(upgradeSql`
        SELECT state, dispatching_at IS NOT NULL AS has_dispatching_at
        FROM session_deliveries
        WHERE delivery_id = 'upgrade-delivery'
      `).resolves.toMatchObject([{
        state: "dispatching",
        has_dispatching_at: true,
      }]);
    } finally {
      await upgradeSql.unsafe(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE`);
    }
  });

  it("recovers an expired crash attempt and fences the old token from dispatch", async () => {
    await register("delivery-crash", "relation-crash", {
      targetSessionId: "caller-session",
    });
    await repository.claimAttemptForTarget(
      "delivery-crash",
      "caller-session",
      "worker-dead",
      15_000,
    );
    await repository.beginDispatch("delivery-crash", "worker-dead");
    await harness.sql`
      UPDATE session_deliveries
      SET attempt_expires_at = NOW() - INTERVAL '1 second'
      WHERE delivery_id = 'delivery-crash'
    `;

    await expect(repository.expireStaleDeliveryAttempts()).resolves.toBe(1);
    await harness.sql`
      UPDATE session_deliveries
      SET next_attempt_at = NOW()
      WHERE delivery_id = 'delivery-crash'
    `;
    await expect(repository.claimRecoverableCompletionDeliveries(
      "worker-recovered",
      1,
    )).resolves.toMatchObject([
      {
        delivery_id: "delivery-crash",
        state: "claimed",
        attempt_token: "worker-recovered",
      },
    ]);
    await expect(repository.beginDispatch(
      "delivery-crash",
      "worker-dead",
    )).resolves.toBeNull();
    await expect(repository.beginDispatch(
      "delivery-crash",
      "worker-recovered",
    )).resolves.toMatchObject({ state: "dispatching" });
  });

  it("reconciles only transcript-proven startup success and never periodically replays held input", async () => {
    await harness.sql`
      INSERT INTO sessions (session_id, node_id, session_type, status, agent_id)
      VALUES ('other-node-target', 'node-other', 'claude', 'running', 'other')
    `;
    const crashBoundaries = [
      { deliveryId: "delivery-after-dispatching", relation: "after-dispatching" },
      { deliveryId: "delivery-after-memory-enqueue", relation: "after-memory-enqueue" },
      { deliveryId: "delivery-after-queued", relation: "after-queued" },
      { deliveryId: "delivery-after-turn-started", relation: "after-turn-started" },
    ] as const;
    for (const boundary of crashBoundaries) {
      await register(boundary.deliveryId, boundary.relation, {
        targetSessionId: "caller-session",
      });
      await repository.claimAttemptForTarget(
        boundary.deliveryId,
        "caller-session",
        `dead:${boundary.deliveryId}`,
      );
      await repository.beginDispatch(
        boundary.deliveryId,
        `dead:${boundary.deliveryId}`,
      );
    }
    await register("delivery-other-node-queued", "other-node-queued", {
      targetSessionId: "other-node-target",
    });
    await repository.claimAttemptForTarget(
      "delivery-other-node-queued",
      "other-node-target",
      "healthy-other-node",
    );
    await repository.beginDispatch(
      "delivery-other-node-queued",
      "healthy-other-node",
    );
    await repository.markQueued(
      "delivery-other-node-queued",
      "healthy-other-node",
    );
    await repository.markQueued(
      "delivery-after-queued",
      "dead:delivery-after-queued",
    );
    await repository.markQueued(
      "delivery-after-turn-started",
      "dead:delivery-after-turn-started",
    );
    await repository.markDelivered(
      "delivery-after-turn-started",
      "event:turn-started",
    );
    await harness.sql`
      UPDATE session_deliveries
      SET attempt_expires_at = NOW() - INTERVAL '1 second'
      WHERE state = 'dispatching'
    `;

    const queuedRecovery = makeQueuedRecovery("queued-startup", async () => ({
      kind: "absent",
      inputUuid: "not-persisted",
    }));
    // Startup recovery settles transcript-proven success and terminalizes an
    // absent stable identity: replaying that UUID cannot produce a new Result.
    await expect(
      queuedRecovery.recoverAfterNodeRestart("node-test"),
    ).resolves.toEqual({ claimed: 1, settled: 1 });
    await expect(repository.get("delivery-after-queued")).resolves.toMatchObject({
      state: "uncertain",
      aggregate_state: "dead_letter",
      last_error: "queued_transcript_input_absent",
    });
    await expect(repository.expireStaleDeliveryAttempts()).resolves.toBe(2);

    const dispatch = vi.fn();
    const coordinator = new CompletionDeliveryCoordinator({
      repository,
      dispatch,
      logger: { error() {}, warn() {} },
    }, "recovery-worker");

    await coordinator.recoverPending(10);
    await coordinator.recoverPending(10);

    expect(dispatch).not.toHaveBeenCalled();
    await expect(repository.get("delivery-after-dispatching")).resolves.toMatchObject({
      state: "pending",
      aggregate_state: "pending",
    });
    await expect(repository.get("delivery-after-memory-enqueue")).resolves.toMatchObject({
      state: "pending",
      aggregate_state: "pending",
    });
    await expect(repository.get("delivery-after-queued")).resolves.toMatchObject({
      state: "uncertain",
      aggregate_state: "dead_letter",
      last_error: "queued_transcript_input_absent",
    });
    await expect(repository.get("delivery-after-turn-started")).resolves.toMatchObject({
      state: "delivered",
      caller_turn_id: "event:turn-started",
    });
    await expect(repository.get("delivery-other-node-queued")).resolves.toMatchObject({
      state: "queued",
      target_session_id: "other-node-target",
    });

    // A stale remote heartbeat does not authorize periodic model execution.
    await harness.sql`
      INSERT INTO soulstream_node_heartbeats (node_id, last_seen_at)
      VALUES ('node-other', NOW() - INTERVAL '10 minutes')
      ON CONFLICT (node_id) DO UPDATE
      SET last_seen_at = EXCLUDED.last_seen_at
    `;
    await coordinator.recoverPending(10);
    await expect(repository.get("delivery-other-node-queued")).resolves.toMatchObject({
      state: "queued",
      aggregate_state: "pending",
      target_session_id: "other-node-target",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("settles a queued delivery from the transcript without replaying its SDK input", async () => {
    await register("delivery-transcript", "relation-transcript", {
      targetSessionId: "caller-session",
    });
    await repository.claimAttemptForTarget(
      "delivery-transcript",
      "caller-session",
      "worker-before-crash",
    );
    await repository.beginDispatch(
      "delivery-transcript",
      "worker-before-crash",
    );
    await repository.markQueued(
      "delivery-transcript",
      "worker-before-crash",
    );

    const dispatched: string[] = [];
    const queuedRecovery = makeQueuedRecovery(
      "queued-transcript",
      async (row) => ({
        kind: "completed",
        inputUuid: buildDeliveryInputUuid(row.delivery_id),
        assistantMessageUuid: "assistant-result-uuid",
      }),
    );
    const coordinator = new CompletionDeliveryCoordinator({
      repository,
      dispatch: async (params) => {
        dispatched.push(params.deliveryId!);
      },
      logger: { error() {}, warn() {} },
    }, "transcript-coordinator");

    await queuedRecovery.recoverAfterNodeRestart("node-test");
    await coordinator.recoverPending(10);
    await coordinator.recoverPending(10);

    expect(dispatched).toEqual([]);
    await expect(repository.get("delivery-transcript")).resolves.toMatchObject({
      state: "consumed",
      caller_turn_id: "transcript:assistant-result-uuid",
      target_receipt_id: "transcript:assistant-result-uuid",
      consumed_at: expect.any(Date),
      last_error: "worker_restart_transcript_reconciled",
    });
  });

  it("boot recovery converges a terminal queued delivery with its exact stale outbox", async () => {
    const deliveryId = "delivery-r37-stale-outbox";
    const relationKey = "relation-r37-stale-outbox";
    await register(deliveryId, relationKey, {
      targetSessionId: "caller-session",
    });
    await repository.claimAttemptForTarget(
      deliveryId,
      "caller-session",
      "worker-before-restart",
    );
    await repository.beginDispatch(deliveryId, "worker-before-restart");
    await repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      attemptToken: "worker-before-restart",
      targetSessionId: "caller-session",
      disposition: "queued",
      payload: notificationPayload(deliveryId, relationKey),
    }, 0);

    const task: Task = {
      agentSessionId: "caller-session",
      prompt: "previous turn",
      status: "completed",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      lastEventId: 77,
      terminalEventId: 77,
      lastReadEventId: 70,
      interventionQueue: [],
    };
    const runningTransitions = vi.fn();
    const executionStarts = vi.fn();
    const autoResumeTransition = {
      resume: vi.fn(async (
        resumedTask: Task,
        _message: InterventionMessage,
        callback: (task: Task) => void,
        options?: { afterRunningTransition?: () => Promise<void> },
      ) => {
        runningTransitions();
        resumedTask.status = "initializing";
        await options?.afterRunningTransition?.();
        resumedTask.status = "running";
        callback(resumedTask);
        return { autoResumed: true } as const;
      }),
    };
    const route = new TaskInterventionRoute({
      getTask: () => task,
      loadEvictedTask: async () => null,
      rememberTask: () => {},
      runningInterventionTransition: {
        deliver: vi.fn(),
        queueOnly: vi.fn(),
      },
      autoResumeTransition: autoResumeTransition as never,
      deliveryLedgerGate: new TaskDeliveryLedgerGate(true, repository),
      sessionNotificationPublisher: {
        publish: vi.fn(async () => ({
          published: true,
          targetReceiptId: "event:r37-redelivery",
        })),
      },
    });
    const queuedRecovery = makeQueuedRecovery(
      "r37-boot-recovery",
      async (row) => ({
        kind: "absent",
        inputUuid: buildDeliveryInputUuid(row.delivery_id),
      }),
      async (row) => {
        await redeliverStoredDeliveryContent(row, route, executionStarts);
      },
    );

    await expect(queuedRecovery.recoverAfterNodeRestart("node-test"))
      .resolves.toEqual({ claimed: 1, settled: 1 });
    expect(runningTransitions).toHaveBeenCalledOnce();
    expect(executionStarts).toHaveBeenCalledOnce();
    expect(task.status).toBe("running");
    await expect(repository.get(deliveryId)).resolves.toMatchObject({
      state: "delivered",
      aggregate_state: "delivered",
      target_receipt_id: "event:r37-redelivery",
    });
    await expect(repository.notifications.get(deliveryId)).resolves.toMatchObject({
      state: "published",
      projection_state: "published",
      target_receipt_id: "event:r37-redelivery",
    });

    await repository.markConsumed(deliveryId, "turn:r37-redelivery");
    await expect(repository.get(deliveryId)).resolves.toMatchObject({
      state: "consumed",
      aggregate_state: "consumed",
    });
  });

  it("converges a post-SIGINT boot snapshot once through the production startup entrypoint", async () => {
    for (const [deliveryId, aggregateState] of [
      ["already-seen-consumed", "consumed"],
      ["already-seen-dead-letter", "dead_letter"],
    ] as const) {
      await registerUserDelivery(deliveryId, `content for ${deliveryId}`);
      const worker = `crashed:${deliveryId}`;
      await repository.claimAttemptForTarget(deliveryId, "caller-session", worker);
      await repository.beginDispatch(deliveryId, worker);
      await repository.markQueued(deliveryId, worker);
      await harness.sql`
        UPDATE session_deliveries
        SET aggregate_state = ${aggregateState}
        WHERE delivery_id = ${deliveryId}
      `;
    }
    await registerUserDelivery("unseen-after-sigint", "deliver me once");
    await repository.claimAttemptForTarget(
      "unseen-after-sigint",
      "caller-session",
      "crashed:unseen-after-sigint",
    );
    await repository.beginDispatch(
      "unseen-after-sigint",
      "crashed:unseen-after-sigint",
    );
    await repository.markQueued(
      "unseen-after-sigint",
      "crashed:unseen-after-sigint",
    );

    const redelivered: string[] = [];
    const queuedRecovery = makeQueuedRecovery(
      "r27-boot-pass",
      async (row) => ({
        kind: "absent",
        inputUuid: buildDeliveryInputUuid(row.delivery_id),
      }),
      async (row) => {
        redelivered.push(row.delivery_id);
        const dispatching = await repository.beginDispatch(
          row.delivery_id,
          row.attempt_token ?? undefined,
        );
        if (!dispatching) throw new Error(`cannot dispatch ${row.delivery_id}`);
        const queued = await repository.markQueued(
          row.delivery_id,
          row.attempt_token ?? undefined,
        );
        if (!queued) throw new Error(`cannot queue ${row.delivery_id}`);
        const consumed = await repository.markConsumed(
          row.delivery_id,
          `turn:${row.delivery_id}`,
        );
        if (!consumed) throw new Error(`cannot consume ${row.delivery_id}`);
      },
    );
    const recoverBootSnapshot = vi.fn(() =>
      queuedRecovery.recoverAfterNodeRestart("node-test")
    );
    const startup = new ClaudeRuntimeStartupRecovery({
      recoverQueuedDeliveries: recoverBootSnapshot,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nodeId: "node-test",
    });

    await startup.afterRunnerRecovery();
    await startup.afterRunnerRecovery();

    expect(recoverBootSnapshot).toHaveBeenCalledOnce();
    expect(redelivered).toEqual(["unseen-after-sigint"]);
    await expect(repository.get("unseen-after-sigint")).resolves.toMatchObject({
      state: "consumed",
      aggregate_state: "consumed",
      consumed_at: expect.any(Date),
    });
    const [unfinished] = await harness.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM session_deliveries
      WHERE aggregate_state NOT IN ('consumed', 'dead_letter')
    `;
    expect(unfinished?.count).toBe(0);
    await expect(startup.stop()).resolves.toBe("drained");
  });

  it("does not reclaim or re-inject a delivered runtime follow-up with a receipt", async () => {
    await registerUserDelivery("orphan-queued", "content for orphan-queued");
    await repository.register({
      deliveryId: "orphan-delivered",
      targetSessionId: "caller-session",
      relationKey: "claude_runtime:caller-session:sdk-session:task@77",
      completionId: "runtime-followup:task@77",
      intent: "runtime_followup",
      source: "claude_runtime_task_followup",
      producerKind: "claude_background_task",
      producerId: "task",
      producerTerminalRevision: "task@77",
      payloadHash: "hash-orphan-delivered",
      payload: {
        text: "background task finished",
        user: "system",
        source: "claude_runtime_task_followup",
      },
    });
    for (const deliveryId of ["orphan-queued", "orphan-delivered"] as const) {
      const worker = `crashed:${deliveryId}`;
      await repository.claimAttemptForTarget(deliveryId, "caller-session", worker);
      await repository.beginDispatch(deliveryId, worker);
      await repository.markQueued(deliveryId, worker);
    }
    await repository.markDelivered("orphan-delivered", "event:orphan-delivered");
    for (const [deliveryId, aggregateState] of [
      ["terminal-consumed", "consumed"],
      ["terminal-dead-letter", "dead_letter"],
    ] as const) {
      await registerUserDelivery(deliveryId, `content for ${deliveryId}`);
      const worker = `crashed:${deliveryId}`;
      await repository.claimAttemptForTarget(deliveryId, "caller-session", worker);
      await repository.beginDispatch(deliveryId, worker);
      await repository.markQueued(deliveryId, worker);
      await harness.sql`
        UPDATE session_deliveries
        SET aggregate_state = ${aggregateState},
            caller_turn_id = ${`receipt:${deliveryId}`},
            target_receipt_id = ${`receipt:${deliveryId}`},
            target_receipt_at = NOW(), delivered_at = NOW()
        WHERE delivery_id = ${deliveryId}
      `;
    }

    const inspected: string[] = [];
    const redelivered: string[] = [];
    const queuedRecovery = makeQueuedRecovery(
      "orphan-content-worker",
      async (row) => {
        inspected.push(row.delivery_id);
        return {
          kind: "absent" as const,
          inputUuid: buildDeliveryInputUuid(row.delivery_id),
        };
      },
      async (row) => {
        redelivered.push(row.delivery_id);
        const dispatching = await repository.beginDispatch(
          row.delivery_id,
          row.attempt_token ?? undefined,
        );
        if (!dispatching) throw new Error(`cannot dispatch ${row.delivery_id}`);
        const queued = await repository.markQueued(
          row.delivery_id,
          row.attempt_token ?? undefined,
        );
        if (!queued) throw new Error(`cannot queue ${row.delivery_id}`);
      },
    );

    await expect(queuedRecovery.recoverAfterNodeRestart("node-test")).resolves
      .toEqual({ claimed: 1, settled: 1 });
    expect(inspected).toEqual(["orphan-queued"]);
    expect(redelivered).toEqual(["orphan-queued"]);
    await expect(repository.get("orphan-queued")).resolves.toMatchObject({
      state: "queued",
      aggregate_state: "pending",
    });
    await expect(repository.get("orphan-delivered")).resolves.toMatchObject({
      state: "delivered",
      aggregate_state: "delivered",
      caller_turn_id: "event:orphan-delivered",
      target_receipt_id: "event:orphan-delivered",
      target_receipt_at: expect.any(Date),
      delivered_at: expect.any(Date),
      attempt_count: 0,
      dead_lettered_at: null,
    });
    await expect(repository.get("terminal-consumed")).resolves.toMatchObject({
      state: "queued",
      aggregate_state: "consumed",
      target_receipt_id: "receipt:terminal-consumed",
    });
    await expect(repository.get("terminal-dead-letter")).resolves.toMatchObject({
      state: "queued",
      aggregate_state: "dead_letter",
      target_receipt_id: "receipt:terminal-dead-letter",
    });
  });

  it("keeps the legacy transcript response delivered while new orch stores it consumed", async () => {
    await register("delivery-old-soul-new-orch", "relation-old-soul-new-orch", {
      targetSessionId: "caller-session",
    });
    await repository.claimAttemptForTarget(
      "delivery-old-soul-new-orch",
      "caller-session",
      "worker-before-crash",
    );
    await repository.beginDispatch(
      "delivery-old-soul-new-orch",
      "worker-before-crash",
    );
    await repository.markQueued(
      "delivery-old-soul-new-orch",
      "worker-before-crash",
    );
    const [claimed] = await repository.recovery.claimQueuedAfterNodeRestart(
      "node-test",
      "old-soul-worker",
      10,
      60_000,
    );
    expect(claimed?.delivery_id).toBe("delivery-old-soul-new-orch");

    const recovery = repository.recovery as typeof repository.recovery & {
      markDeliveredFromTranscript?: (
        deliveryId: string,
        attemptToken: string,
        assistantMessageUuid: string,
      ) => Promise<SessionDeliveryRow | null>;
      markConsumedFromTranscript?: (
        deliveryId: string,
        attemptToken: string,
        assistantMessageUuid: string,
      ) => Promise<SessionDeliveryRow | null>;
    };
    const legacyAction = recovery.markDeliveredFromTranscript
      ?? recovery.markConsumedFromTranscript;
    if (!legacyAction) throw new Error("legacy transcript action is unavailable");
    const legacyResponse = await legacyAction.call(
      recovery,
      "delivery-old-soul-new-orch",
      "old-soul-worker",
      "assistant-old-soul",
    );

    expect(legacyResponse).toMatchObject({
      state: "delivered",
      target_receipt_id: "transcript:assistant-old-soul",
    });
    const stored = await repository.get("delivery-old-soul-new-orch");
    expect(stored).toMatchObject({
      state: "consumed",
      target_receipt_id: "transcript:assistant-old-soul",
      consumed_at: expect.any(Date),
    });
    const consumedAt = stored?.consumed_at?.toISOString();
    await expect(repository.claimRecoverableCompletionDeliveries(
      "post-consume-worker",
      10,
      15_000,
    )).resolves.toEqual([]);
    const afterRecovery = await repository.get("delivery-old-soul-new-orch");
    expect(afterRecovery).toMatchObject({ state: "consumed" });
    expect(afterRecovery?.consumed_at?.toISOString()).toBe(consumedAt);
  });

  it("returns an accepted SDK input to pending while its assistant transcript is unproven", async () => {
    await register("delivery-input-pending", "relation-input-pending", {
      targetSessionId: "caller-session",
    });
    await repository.claimAttemptForTarget(
      "delivery-input-pending",
      "caller-session",
      "worker-before-crash",
    );
    await repository.beginDispatch(
      "delivery-input-pending",
      "worker-before-crash",
    );
    await repository.markQueued(
      "delivery-input-pending",
      "worker-before-crash",
    );

    const queuedRecovery = makeQueuedRecovery(
      "queued-input-pending",
      async (row) => ({
        kind: "input_pending",
        inputUuid: buildDeliveryInputUuid(row.delivery_id),
      }),
    );
    await expect(
      queuedRecovery.recoverAfterNodeRestart("node-test"),
    ).resolves.toEqual({ claimed: 1, settled: 0 });

    // The stable SDK input identity fences duplicate execution while the
    // unproven delivery returns to the ordinary reconnect retry path.
    await expect(repository.get("delivery-input-pending")).resolves.toMatchObject({
      state: "pending",
      aggregate_state: "pending",
      attempt_count: 1,
      last_error: "queued_transcript_input_pending",
    });
  });

  it("terminalizes transcript-absent identity before reconnect replay", async () => {
    await register("delivery-stale-identity", "relation-stale-identity", {
      targetSessionId: "caller-session",
    });
    await repository.claimAttemptForTarget(
      "delivery-stale-identity",
      "caller-session",
      "worker-before-crash",
    );
    await repository.beginDispatch(
      "delivery-stale-identity",
      "worker-before-crash",
    );
    await repository.markQueued(
      "delivery-stale-identity",
      "worker-before-crash",
    );
    const queuedRecovery = makeQueuedRecovery(
      "stale-identity-worker",
      async (row) => ({
        kind: "absent",
        inputUuid: buildDeliveryInputUuid(row.delivery_id),
      }),
    );
    await expect(
      queuedRecovery.recoverAfterNodeRestart("node-test"),
    ).resolves.toEqual({ claimed: 1, settled: 1 });
    await expect(repository.get("delivery-stale-identity")).resolves
      .toMatchObject({
        state: "uncertain",
        aggregate_state: "dead_letter",
        last_error: "queued_transcript_input_absent",
      });
    await expect(
      queuedRecovery.recoverAfterNodeRestart("node-test"),
    ).resolves.toEqual({ claimed: 0, settled: 0 });
    await expect(repository.recovery.claimPendingImmediateIntentsForNode(
      "node-test",
      "node-ready-worker",
    )).resolves.toEqual([]);
  });

  it("rolls ledger and notification outbox forward atomically", async () => {
    await register("delivery-outbox", "relation-outbox", {
      targetSessionId: "caller-session",
    });
    await repository.claimAttemptForTarget(
      "delivery-outbox",
      "caller-session",
      "worker-outbox",
    );
    await repository.beginDispatch("delivery-outbox", "worker-outbox");
    await harness.sql.unsafe(`
      CREATE OR REPLACE FUNCTION reject_delivery_outbox()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected outbox failure';
      END;
      $$;
      CREATE TRIGGER reject_delivery_outbox_insert
      BEFORE INSERT ON session_delivery_notification_outbox
      FOR EACH ROW EXECUTE FUNCTION reject_delivery_outbox();
    `);

    await expect(repository.notifications.stageWithQueuedDelivery({
      deliveryId: "delivery-outbox",
      attemptToken: "worker-outbox",
      targetSessionId: "caller-session",
      disposition: "queued",
      payload: notificationPayload("delivery-outbox", "relation-outbox"),
    })).rejects.toThrow("injected outbox failure");
    expect(await repository.get("delivery-outbox")).toMatchObject({
      state: "dispatching",
    });
    expect(await harness.sql`
      SELECT delivery_id FROM session_delivery_notification_outbox
      WHERE delivery_id = 'delivery-outbox'
    `).toHaveLength(0);

    await harness.sql`
      DROP TRIGGER reject_delivery_outbox_insert
      ON session_delivery_notification_outbox
    `;
    await expect(repository.notifications.stageWithQueuedDelivery({
      deliveryId: "delivery-outbox",
      attemptToken: "worker-outbox",
      targetSessionId: "caller-session",
      disposition: "queued",
      payload: notificationPayload("delivery-outbox", "relation-outbox"),
    })).resolves.toMatchObject({ state: "queued" });
    expect(await harness.sql`
      SELECT state, attempt_token
      FROM session_delivery_notification_outbox
      WHERE delivery_id = 'delivery-outbox'
    `).toMatchObject([
      { state: "claimed", attempt_token: "worker-outbox" },
    ]);
  });

  it("validates notification payload before advancing the delivery ledger", async () => {
    await register("delivery-invalid-stage", "relation-invalid-stage", {
      targetSessionId: "caller-session",
    });
    await repository.claimAttemptForTarget(
      "delivery-invalid-stage",
      "caller-session",
      "worker-invalid-stage",
    );
    await repository.beginDispatch("delivery-invalid-stage", "worker-invalid-stage");

    await expect(repository.notifications.stageWithQueuedDelivery({
      deliveryId: "delivery-invalid-stage",
      attemptToken: "worker-invalid-stage",
      targetSessionId: "caller-session",
      disposition: "queued",
      payload: { text: "done" },
    })).rejects.toThrow("Notification outbox payload is missing user");

    await expect(repository.get("delivery-invalid-stage")).resolves.toMatchObject({
      state: "dispatching",
    });
    expect(await harness.sql`
      SELECT delivery_id FROM session_delivery_notification_outbox
      WHERE delivery_id = 'delivery-invalid-stage'
    `).toHaveLength(0);
  });

  it("claims notification rows only on the target session owner node", async () => {
    await harness.sql`
      INSERT INTO sessions (session_id, node_id, session_type, status, agent_id)
      VALUES
        ('other-caller-session', 'node-other', 'claude', 'completed', 'caller'),
        ('ownerless-caller-session', NULL, 'claude', 'completed', 'caller')
    `;
    for (const [deliveryId, relationKey, targetSessionId, worker] of [
      ["delivery-node-local", "relation-node-local", "caller-session", "worker-local"],
      ["delivery-node-other", "relation-node-other", "other-caller-session", "worker-other"],
      [
        "delivery-node-ownerless",
        "relation-node-ownerless",
        "ownerless-caller-session",
        "worker-ownerless",
      ],
    ] as const) {
      await register(deliveryId, relationKey, { targetSessionId });
      await repository.claimAttemptForTarget(deliveryId, targetSessionId, worker);
      await repository.beginDispatch(deliveryId, worker);
      await repository.notifications.stageWithQueuedDelivery({
        deliveryId,
        attemptToken: worker,
        targetSessionId,
        disposition: "queued",
        payload: notificationPayload(deliveryId, relationKey),
      });
    }
    await harness.sql`
      UPDATE session_delivery_notification_outbox
      SET state = 'pending', attempt_token = NULL, attempt_expires_at = NULL
    `;

    await expect(repository.notifications.claimDue(
      "node-test",
      "notification-node-test",
      100,
    )).resolves.toMatchObject([{ delivery_id: "delivery-node-local" }]);
    await expect(repository.notifications.claimDue(
      "node-other",
      "notification-node-other",
      100,
    )).resolves.toMatchObject([{ delivery_id: "delivery-node-other" }]);
    await expect(harness.sql`
      SELECT state, last_error
      FROM session_delivery_notification_outbox
      WHERE delivery_id = 'delivery-node-ownerless'
    `).resolves.toMatchObject([{
      state: "pending",
      last_error: null,
    }]);
    await expect(harness.sql<Array<{ outcome: string }>>`
      SELECT outcome FROM session_delivery_attempts
      WHERE delivery_id = 'delivery-node-ownerless'
      ORDER BY attempt_number
    `).resolves.toEqual([{ outcome: "accepted" }]);
  });

  it("dead-letters retryable rows and only requeues them through the explicit operator path", async () => {
    for (const [deliveryId, relationKey, worker] of [
      ["delivery-attempt-cap", "relation-attempt-cap", "worker-attempt-cap"],
      ["delivery-age-cap", "relation-age-cap", "worker-age-cap"],
    ] as const) {
      await register(deliveryId, relationKey, { targetSessionId: "caller-session" });
      await repository.claimAttemptForTarget(deliveryId, "caller-session", worker);
      await repository.beginDispatch(deliveryId, worker);
      await repository.notifications.stageWithQueuedDelivery({
        deliveryId,
        attemptToken: worker,
        targetSessionId: "caller-session",
        disposition: "queued",
        payload: notificationPayload(deliveryId, relationKey),
      });
    }
    await harness.sql`
      UPDATE session_delivery_notification_outbox
      SET attempt_count = 15
      WHERE delivery_id = 'delivery-attempt-cap'
    `;
    await harness.sql`
      UPDATE session_delivery_notification_outbox
      SET created_at = NOW() - INTERVAL '25 hours'
      WHERE delivery_id = 'delivery-age-cap'
    `;
    const oldestAllowed = new Date(Date.now() - 24 * 60 * 60 * 1000);

    await expect(repository.notifications.retry(
      "delivery-attempt-cap",
      "worker-attempt-cap",
      "transient failure",
      new Date(),
      16,
      oldestAllowed,
    )).resolves.toMatchObject({ state: "dead_letter", attempt_count: 16 });
    await expect(repository.notifications.retry(
      "delivery-age-cap",
      "worker-age-cap",
      "transient failure",
      new Date(),
      16,
      oldestAllowed,
    )).resolves.toMatchObject({ state: "dead_letter", attempt_count: 1 });

    await expect(repository.notifications.listDeadLetters(10)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ delivery_id: "delivery-attempt-cap" }),
        expect.objectContaining({ delivery_id: "delivery-age-cap" }),
      ]),
    );
    await expect(
      repository.notifications.requeueDeadLetter("delivery-attempt-cap"),
    ).resolves.toMatchObject({
      state: "pending",
      attempt_count: 0,
      last_error: null,
      dead_lettered_at: null,
    });
    await expect(
      repository.notifications.requeueDeadLetter("delivery-attempt-cap"),
    ).resolves.toBeNull();
  });

  it("quarantines residual camelCase deliveryIntent rows in migration 062", async () => {
    const legacySchema =
      `delivery_062_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const legacySql = harness.createPeer();
    const migration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/062_notification_outbox_hardening.sql",
        import.meta.url,
      ),
      "utf8",
    );

    try {
      await legacySql.unsafe(`
        CREATE SCHEMA ${legacySchema};
        SET search_path TO ${legacySchema};
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          node_id TEXT
        );
        CREATE TABLE session_deliveries (
          delivery_id TEXT PRIMARY KEY
        );
        CREATE TABLE session_delivery_notification_outbox (
          delivery_id TEXT PRIMARY KEY
            REFERENCES session_deliveries(delivery_id) ON DELETE CASCADE,
          target_session_id TEXT NOT NULL,
          payload JSONB NOT NULL,
          state TEXT NOT NULL,
          lease_owner TEXT,
          lease_expires_at TIMESTAMPTZ,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT session_delivery_notification_state_check
            CHECK (state IN ('pending', 'claimed', 'published'))
        );
        INSERT INTO sessions (session_id, node_id)
        VALUES ('caller-session', 'node-test');
        INSERT INTO session_deliveries (delivery_id)
        VALUES ('delivery-legacy-camel');
        INSERT INTO session_delivery_notification_outbox (
          delivery_id, target_session_id, payload, state,
          lease_owner, lease_expires_at
        ) VALUES (
          'delivery-legacy-camel', 'caller-session',
          '{"deliveryIntent":"completion_notification"}'::jsonb,
          'pending', NULL, NULL
        );
      `);
      await legacySql.unsafe(migration);

      expect(await legacySql`
        SELECT state, dead_lettered_at, last_error
        FROM session_delivery_notification_outbox
        WHERE delivery_id = 'delivery-legacy-camel'
      `).toMatchObject([{
        state: "dead_letter",
        dead_lettered_at: expect.any(Date),
        last_error: "legacy camelCase deliveryIntent quarantined by migration 062",
      }]);
    } finally {
      await legacySql.unsafe(`DROP SCHEMA IF EXISTS ${legacySchema} CASCADE`);
      await legacySql.end({ timeout: 5 });
    }
  });

  async function register(
    deliveryId: string,
    relationKey: string,
    options: {
      targetSessionId?: string;
    } = {},
  ): Promise<void> {
    await repository.register({
      deliveryId,
      targetSessionId: options.targetSessionId,
      sourceSessionId: "child-session",
      relationKey,
      completionId: `completion-${relationKey}`,
      intent: "completion_notification",
      source: "completion_notifier",
      producerKind: "child_session",
      producerId: "child-session",
      producerTerminalRevision: "42",
      payloadHash: `hash-${relationKey}`,
      payload: { text: "done", user: "agent" },
    });
  }

  async function registerUserDelivery(
    deliveryId: string,
    text: string,
  ): Promise<void> {
    await repository.register({
      deliveryId,
      targetSessionId: "caller-session",
      relationKey: `user_message:caller-session:${deliveryId}`,
      completionId: `message:${deliveryId}`,
      intent: "durable_next_turn",
      source: "user_message",
      payloadHash: `hash-${deliveryId}`,
      payload: { text, user: "alice", source: "user_message" },
    });
  }

  async function activateTarget(
    sessionId: string,
    generation: number,
  ): Promise<void> {
    await harness.sql`
      UPDATE sessions
      SET execution_registration_id = ${`registration-${generation}`},
          execution_command_id = ${`command-${generation}`},
          updated_at = NOW()
      WHERE session_id = ${sessionId}
    `;
  }

  function makeQueuedRecovery(
    workerId: string,
    inspect: ConstructorParameters<
      typeof QueuedDeliveryTranscriptRecovery
    >[0]["transcriptReceipt"]["inspect"],
    redeliverContent?: (row: SessionDeliveryRow) => Promise<void>,
  ): QueuedDeliveryTranscriptRecovery {
    return new QueuedDeliveryTranscriptRecovery({
      deliveryRepository: repository,
      recoveryRepository: repository.recovery,
      transcriptReceipt: { inspect },
      ...(redeliverContent ? { redeliverContent } : {}),
      logger: { warn() {} },
    }, workerId);
  }
});

function notificationPayload(
  deliveryId: string,
  relationKey: string,
): Record<string, unknown> {
  return {
    text: "done",
    user: "agent",
    source: "completion_notifier",
    delivery_id: deliveryId,
    delivery_intent: "completion_notification",
    completion_id: `completion-${relationKey}`,
    relation_key: relationKey,
    disposition: "queued",
    caller_info: null,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((candidate) => {
    resolve = candidate;
  });
  return { promise, resolve };
}

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}

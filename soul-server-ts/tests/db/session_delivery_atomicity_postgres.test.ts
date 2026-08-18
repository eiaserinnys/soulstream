import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDeliveryRepository } from "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import type { SqlClient } from "../../src/db/session_db.js";
import { TaskDeliveryLedgerGate } from "../../src/task/task_delivery_ledger_gate.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import { isDeliveryLayerCombinationAllowed } from
  "../../src/task/delivery_contract.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres =
  hasFullSchemaPostgresBackend || hasDockerBinary() ? describe : describe.skip;

describePostgres("session delivery atomicity PostgreSQL integration", () => {
  let harness: FullSchemaPostgresHarness;
  let peer: SqlClient;
  let repository: SessionDeliveryRepository;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    peer = harness.createPeer();
    repository = new SessionDeliveryRepository(harness.sql);
  }, 45_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_delivery_notification_outbox`;
    await harness.sql`DELETE FROM session_delivery_relation_consumptions`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (session_id, session_type, status, agent_id)
      VALUES
        ('caller-old', 'claude', 'completed', 'ariella'),
        ('caller-mid', 'claude', 'completed', 'ariella'),
        ('caller-new', 'claude', 'completed', 'ariella'),
        ('child-session', 'claude', 'completed', 'worker')
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

  it("serializes consume-first, dispatch-first, and queued-first on the real row", async () => {
    await register("delivery-consume-first", "relation-consume-first");
    await repository.claimForTarget("delivery-consume-first", "caller-old");

    let blockedDispatch!: ReturnType<SessionDeliveryRepository["beginDispatch"]>;
    await peer.begin(async (transaction) => {
      const transactional = new SessionDeliveryRepository(
        transaction as unknown as SqlClient,
      );
      await transaction`
        SELECT 1 FROM session_deliveries
        WHERE delivery_id = 'delivery-consume-first'
        FOR UPDATE
      `;
      blockedDispatch = repository.beginDispatch("delivery-consume-first");
      await new Promise((resolve) => setImmediate(resolve));
      await transactional.markConsumedByRelation(
        "relation-consume-first",
        "completion-relation-consume-first",
        "turn-inline",
      );
    });
    await expect(blockedDispatch).resolves.toBeNull();
    expect((await repository.get("delivery-consume-first"))?.state).toBe("consumed");

    await register("delivery-dispatch-first", "relation-dispatch-first");
    await repository.claimForTarget("delivery-dispatch-first", "caller-old");
    let blockedConsume!: ReturnType<
      SessionDeliveryRepository["markConsumedByRelation"]
    >;
    await peer.begin(async (transaction) => {
      const transactional = new SessionDeliveryRepository(
        transaction as unknown as SqlClient,
      );
      await transaction`
        SELECT 1 FROM session_deliveries
        WHERE delivery_id = 'delivery-dispatch-first'
        FOR UPDATE
      `;
      blockedConsume = repository.markConsumedByRelation(
        "relation-dispatch-first",
        "completion-relation-dispatch-first",
        "turn-inline",
      );
      await new Promise((resolve) => setImmediate(resolve));
      await expect(transactional.beginDispatch("delivery-dispatch-first"))
        .resolves.toMatchObject({ state: "dispatching" });
    });
    await expect(blockedConsume).resolves.toBeNull();
    expect((await repository.get("delivery-dispatch-first"))?.state)
      .toBe("dispatching");

    await register("delivery-queued-first", "relation-queued-first");
    await repository.claimForTarget("delivery-queued-first", "caller-old");
    let blockedQueuedConsume!: ReturnType<
      SessionDeliveryRepository["markConsumedByRelation"]
    >;
    await peer.begin(async (transaction) => {
      const transactional = new SessionDeliveryRepository(
        transaction as unknown as SqlClient,
      );
      await transaction`
        SELECT 1 FROM session_deliveries
        WHERE delivery_id = 'delivery-queued-first'
        FOR UPDATE
      `;
      blockedQueuedConsume = repository.markConsumedByRelation(
        "relation-queued-first",
        "completion-relation-queued-first",
        "turn-inline-late",
      );
      await new Promise((resolve) => setImmediate(resolve));
      await expect(transactional.beginDispatch("delivery-queued-first"))
        .resolves.toMatchObject({ state: "dispatching" });
      await expect(transactional.markQueued("delivery-queued-first"))
        .resolves.toMatchObject({ state: "queued" });
    });
    await expect(blockedQueuedConsume).resolves.toBeNull();
    expect((await repository.get("delivery-queued-first"))?.state).toBe("queued");
  });

  it("atomically supersedes a claimed completion when its source auto-resumes", async () => {
    await register("delivery-resume-race", "relation-resume-race");
    await repository.claimForTarget(
      "delivery-resume-race",
      "caller-old",
      "worker-before-resume",
    );
    await harness.sql`
      UPDATE session_deliveries
      SET last_error = 'transient dispatch failure before resume'
      WHERE delivery_id = 'delivery-resume-race'
    `;

    const resumed = await harness.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_apply_running_transition(
        'child-session',
        'not_required',
        42,
        TRUE,
        NOW()
      )
    `;

    expect(resumed).toMatchObject([{ applied: true }]);
    await expect(repository.get("delivery-resume-race")).resolves.toMatchObject({
      state: "superseded",
      superseded_at: expect.any(Date),
      superseded_terminal_revision: "42",
      lease_owner: null,
      lease_expires_at: null,
      last_error: "transient dispatch failure before resume",
    });
    await expect(repository.beginDispatch(
      "delivery-resume-race",
      "worker-before-resume",
    )).resolves.toBeNull();
    await expect(repository.markUncertain("delivery-resume-race")).resolves.toBeNull();
    await expect(repository.get("delivery-resume-race")).resolves.toMatchObject({
      state: "superseded",
      superseded_terminal_revision: "42",
    });
  });

  it("discards an unpublished notification projection when its aggregate is consumed", async () => {
    await register("delivery-projection-discard", "relation-projection-discard");
    await repository.claimForTarget(
      "delivery-projection-discard",
      "caller-old",
      "projection-worker",
    );
    await repository.beginDispatch(
      "delivery-projection-discard",
      "projection-worker",
    );
    await repository.notifications.stageWithQueuedDelivery({
      deliveryId: "delivery-projection-discard",
      leaseOwner: "projection-worker",
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload: {
        text: "done",
        user: "agent",
        source: "completion_notifier",
        delivery_id: "delivery-projection-discard",
        delivery_intent: "completion_notification",
        completion_id: "completion-relation-projection-discard",
        relation_key: "relation-projection-discard",
        disposition: "auto_resume",
        caller_info: null,
      },
    });

    await harness.sql`
      SELECT * FROM session_apply_running_transition(
        'child-session', 'not_required', 42, TRUE, NOW()
      )
    `;

    await expect(repository.get("delivery-projection-discard")).resolves.toMatchObject({
      state: "superseded",
      aggregate_state: "consumed",
    });
    await expect(harness.sql<Array<{
      state: string;
      projection_state: string;
      lease_owner: string | null;
    }>>`
      SELECT state, projection_state, lease_owner
      FROM session_delivery_notification_outbox
      WHERE delivery_id = 'delivery-projection-discard'
    `).resolves.toEqual([{
      state: "dead_letter",
      projection_state: "discarded",
      lease_owner: null,
    }]);
    await expect(repository.notifications.listDeadLetters()).resolves.toEqual([]);
    await expect(repository.notifications.requeueDeadLetter(
      "delivery-projection-discard",
    )).resolves.toBeNull();
    await expect(harness.sql<Array<{ outcome: string }>>`
      SELECT outcome FROM session_delivery_attempts
      WHERE delivery_id = 'delivery-projection-discard'
      ORDER BY attempt_number
    `).resolves.toEqual([{ outcome: "accepted" }]);
  });

  it("projects an orphaned notification receipt when the same target turn already delivered the aggregate", async () => {
    const deliveryId = "delivery-orphaned-receipt";
    const targetReceiptId = "event:901";
    await register(deliveryId, "relation-orphaned-receipt");
    await repository.claimForTarget(deliveryId, "caller-old", "route-worker");
    await repository.beginDispatch(deliveryId, "route-worker");
    await repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      leaseOwner: "route-worker",
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload: {
        text: "done",
        user: "agent",
        source: "completion_notifier",
        delivery_id: deliveryId,
        delivery_intent: "completion_notification",
        completion_id: "completion-relation-orphaned-receipt",
        relation_key: "relation-orphaned-receipt",
        disposition: "auto_resume",
        caller_info: null,
      },
    });

    await expect(repository.markDelivered(deliveryId, targetReceiptId))
      .resolves.toMatchObject({
        aggregate_state: "delivered",
        target_receipt_id: targetReceiptId,
      });

    await expect(repository.notifications.markPublished(
      deliveryId,
      "route-worker",
      "event:902",
    )).rejects.toThrow(`notification delivery receipt was not projected: ${deliveryId}`);
    await expect(harness.sql<Array<{
      state: string;
      projection_state: string;
      target_receipt_id: string | null;
    }>>`
      SELECT state, projection_state, target_receipt_id
      FROM session_delivery_notification_outbox
      WHERE delivery_id = ${deliveryId}
    `).resolves.toEqual([{
      state: "claimed",
      projection_state: "publishing",
      target_receipt_id: null,
    }]);

    await expect(repository.notifications.markPublished(
      deliveryId,
      "route-worker",
      targetReceiptId,
    )).resolves.toMatchObject({
      state: "published",
      projection_state: "published",
      target_receipt_id: targetReceiptId,
    });
    await expect(repository.get(deliveryId)).resolves.toMatchObject({
      aggregate_state: "delivered",
      target_receipt_id: targetReceiptId,
    });
  });

  it("stages an expired same-owner dispatch and rejects the replaced owner", async () => {
    await harness.sql`
      UPDATE sessions SET node_id = 'node-a' WHERE session_id = 'caller-old'
    `;
    await register("delivery-expired-stage", "relation-expired-stage");
    await repository.claimForTarget(
      "delivery-expired-stage",
      "caller-old",
      "worker-original",
    );
    await repository.beginDispatch("delivery-expired-stage", "worker-original");
    await harness.sql`
      UPDATE session_deliveries
      SET lease_expires_at = NOW() - INTERVAL '1 second'
      WHERE delivery_id = 'delivery-expired-stage'
    `;

    await expect(repository.notifications.stageWithQueuedDelivery({
      deliveryId: "delivery-expired-stage",
      leaseOwner: "worker-original",
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload: {
        text: "done",
        user: "agent",
        source: "completion_notifier",
        delivery_id: "delivery-expired-stage",
        delivery_intent: "completion_notification",
        completion_id: "completion-relation-expired-stage",
        relation_key: "relation-expired-stage",
        disposition: "auto_resume",
        caller_info: null,
      },
    })).resolves.toMatchObject({ state: "queued" });
    await expect(harness.sql<Array<{ lease_is_fresh: boolean }>>`
      SELECT lease_expires_at > NOW() AS lease_is_fresh
      FROM session_delivery_notification_outbox
      WHERE delivery_id = 'delivery-expired-stage'
    `).resolves.toEqual([{ lease_is_fresh: true }]);
    await expect(repository.notifications.releaseExpiredLeases(
      4,
      new Date(0),
    )).resolves.toBe(0);
    await expect(repository.notifications.claimDue(
      "node-a",
      "notification-recovery",
    )).resolves.toEqual([]);

    await register("delivery-replaced-owner", "relation-replaced-owner");
    await repository.claimForTarget(
      "delivery-replaced-owner",
      "caller-old",
      "worker-old",
    );
    await repository.beginDispatch("delivery-replaced-owner", "worker-old");
    await harness.sql`
      UPDATE session_deliveries
      SET lease_owner = 'worker-new'
      WHERE delivery_id = 'delivery-replaced-owner'
    `;
    await expect(repository.notifications.stageWithQueuedDelivery({
      deliveryId: "delivery-replaced-owner",
      leaseOwner: "worker-old",
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload: {
        text: "done",
        user: "agent",
        source: "completion_notifier",
        delivery_id: "delivery-replaced-owner",
        delivery_intent: "completion_notification",
        completion_id: "completion-relation-replaced-owner",
        relation_key: "relation-replaced-owner",
        disposition: "auto_resume",
        caller_info: null,
      },
    })).resolves.toBeNull();
  });

  it("recovers only the latest terminal revision and rechecks it at dispatch", async () => {
    await register("delivery-revision-42", "relation-revision-42");
    await harness.sql`
      SELECT * FROM session_apply_running_transition(
        'child-session', 'not_required', 42, TRUE, NOW()
      )
    `;
    await harness.sql`
      SELECT * FROM session_apply_terminal_transition(
        'child-session',
        'completed',
        'completed_ok',
        NULL,
        'not_required',
        'revision 43',
        43,
        NOW()
      )
    `;
    await repository.register({
      deliveryId: "delivery-revision-43",
      targetSessionId: "caller-old",
      sourceSessionId: "child-session",
      relationKey: "relation-revision-43",
      completionId: "completion-revision-43",
      intent: "completion_notification",
      source: "completion_notifier",
      producerKind: "child_session",
      producerId: "child-session",
      producerTerminalRevision: "43",
      payloadHash: "hash-revision-43",
      payload: { text: "revision 43" },
    });

    const recovered = await repository.claimRecoverableCompletionDeliveries(
      "recovery-worker",
      10,
    );
    expect(recovered.map((row) => row.delivery_id)).toEqual(["delivery-revision-43"]);
    await expect(repository.beginDispatch(
      "delivery-revision-43",
      "recovery-worker",
    )).resolves.toMatchObject({ state: "dispatching" });

    await harness.sql`
      UPDATE sessions
      SET termination_event_id = 44
      WHERE session_id = 'child-session'
    `;
    await repository.register({
      deliveryId: "delivery-stale-at-dispatch",
      targetSessionId: "caller-old",
      sourceSessionId: "child-session",
      relationKey: "relation-stale-at-dispatch",
      completionId: "completion-stale-at-dispatch",
      intent: "completion_notification",
      source: "completion_notifier",
      producerKind: "child_session",
      producerId: "child-session",
      producerTerminalRevision: "43",
      payloadHash: "hash-stale-at-dispatch",
      payload: { text: "stale" },
    });
    await repository.claimForTarget(
      "delivery-stale-at-dispatch",
      "caller-old",
      "stale-worker",
    );
    await expect(repository.beginDispatch(
      "delivery-stale-at-dispatch",
      "stale-worker",
    )).resolves.toBeNull();
  });

  it("suppresses an already-consumed PostgreSQL row before queue, resume, wake, or publish", async () => {
    const gate = new TaskDeliveryLedgerGate(true, repository);
    const params = {
      agentSessionId: "caller-old",
      text: "done",
      user: "agent",
      deliveryId: "delivery-consumed-e2e",
      deliveryIntent: "completion_notification" as const,
      source: "completion_notifier",
      completionId: "completion-consumed-e2e",
      relationKey: "relation-consumed-e2e",
    };
    await gate.recordInlineConsumed(params, {
      agentSessionId: "caller-old",
      prompt: "",
      status: "completed",
      lastEventId: 9,
      lastReadEventId: 0,
      interventionQueue: [],
      createdAt: new Date(),
    });

    const getTask = vi.fn();
    const queueOnly = vi.fn();
    const deliver = vi.fn();
    const resume = vi.fn();
    const publish = vi.fn();
    const wake = vi.fn();
    const route = new TaskInterventionRoute({
      getTask,
      loadEvictedTask: vi.fn(),
      rememberTask: vi.fn(),
      activeTaskRecovery: { prepareForIntervention: vi.fn() },
      runningInterventionTransition: { queueOnly, deliver },
      autoResumeTransition: { resume },
      deliveryLedgerGate: gate,
      sessionNotificationPublisher: { publish },
    });

    await expect(route.addIntervention(params, wake)).resolves.toMatchObject({
      suppressed: true,
      reason: "delivery_consumed",
    });
    expect(getTask).not.toHaveBeenCalled();
    expect(queueOnly).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("suppresses a late child notifier after inline consumption existed before its row", async () => {
    const gate = new TaskDeliveryLedgerGate(true, repository);
    const relationKey = "child_session:child-session:77";
    const completionId = "completion-inline-before-notifier";
    await gate.recordConsumed({
      text: "child result consumed directly by the caller turn",
      user: "agent",
      deliveryIntent: "completion_notification",
      completionId,
      relationKey,
    }, {
      agentSessionId: "caller-old",
      prompt: "delegate",
      status: "running",
      lastEventId: 44,
      lastReadEventId: 0,
      interventionQueue: [],
      createdAt: new Date(),
    });

    const getTask = vi.fn();
    const queueOnly = vi.fn();
    const deliver = vi.fn();
    const resume = vi.fn();
    const publish = vi.fn();
    const wake = vi.fn();
    const route = new TaskInterventionRoute({
      getTask,
      loadEvictedTask: vi.fn(),
      rememberTask: vi.fn(),
      activeTaskRecovery: { prepareForIntervention: vi.fn() },
      runningInterventionTransition: { queueOnly, deliver },
      autoResumeTransition: { resume },
      deliveryLedgerGate: gate,
      sessionNotificationPublisher: { publish },
    });
    const params = {
      agentSessionId: "caller-old",
      text: "late duplicate",
      user: "agent",
      deliveryId: "delivery-late-child-notifier",
      deliveryIntent: "completion_notification" as const,
      source: "completion_notifier",
      completionId,
      relationKey,
    };

    await expect(route.addIntervention(params, wake)).resolves.toMatchObject({
      suppressed: true,
      reason: "delivery_consumed",
    });
    expect(await repository.getRelationConsumption(relationKey)).toMatchObject({
      completion_id: completionId,
      caller_session_id: "caller-old",
      consumed_turn_id: "event:44",
    });
    expect(await repository.get(params.deliveryId)).toMatchObject({
      state: "consumed",
      consumed_at: expect.any(Date),
    });
    expect(getTask).not.toHaveBeenCalled();
    expect(queueOnly).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("serializes notifier registration against inline relation consumption", async () => {
    const writer = new SessionDeliveryRepository(harness.createPeer());
    const relationKey = "child_session:child-session:88";
    const completionId = "completion-concurrent-inline";
    const registration = {
      deliveryId: "delivery-concurrent-inline",
      targetSessionId: "caller-old",
      sourceSessionId: "child-session",
      relationKey,
      completionId,
      intent: "completion_notification" as const,
      source: "completion_notifier",
      payloadHash: "hash-concurrent-inline",
      payload: { text: "done" },
    };

    await Promise.all([
      repository.register(registration),
      writer.recordRelationConsumed({
        relationKey,
        completionId,
        callerSessionId: "caller-old",
        consumedTurnId: "event:55",
      }),
    ]);

    expect(await repository.get(registration.deliveryId)).toMatchObject({
      state: "consumed",
    });
    expect(await repository.getRelationConsumption(relationKey)).toMatchObject({
      completion_id: completionId,
      caller_session_id: "caller-old",
    });
  });

  it("uses the monotonic enqueue sequence for concurrent equal-time runtime admission and exact replay", async () => {
    const createdAt = new Date("2026-08-18T00:00:00.000Z");
    const followupKey = "caller-old:task-equal-time";
    const registrations = ["a", "b"].map((suffix) => ({
      deliveryId: `runtime-equal-${suffix}`,
      targetSessionId: "caller-old",
      relationKey: `runtime-equal-relation-${suffix}`,
      completionId: `runtime-equal-completion-${suffix}`,
      intent: "runtime_followup" as const,
      source: "claude_runtime_task_followup",
      payloadHash: `runtime-equal-hash-${suffix}`,
      payload: {
        text: `equal ${suffix}`,
        user: "system",
        source: "claude_runtime_task_followup",
        followup_key: followupKey,
        followup_attempt: 2,
      },
      createdAt,
    }));
    const peerRepository = new SessionDeliveryRepository(harness.createPeer());

    await Promise.all([
      repository.register(registrations[0]!),
      peerRepository.register(registrations[1]!),
    ]);

    const rows = await harness.sql<Array<{
      delivery_id: string;
      state: string;
      enqueue_sequence: string;
    }>>`
      SELECT delivery_id, state, enqueue_sequence
      FROM session_deliveries
      WHERE payload->>'followup_key' = ${followupKey}
      ORDER BY enqueue_sequence
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.state).toBe("superseded");
    expect(rows[1]?.state).toBe("pending");
    expect(BigInt(rows[1]!.enqueue_sequence)).toBeGreaterThan(
      BigInt(rows[0]!.enqueue_sequence),
    );

    await harness.sql`
      INSERT INTO session_deliveries (
        delivery_id, target_session_id, relation_key, completion_id,
        intent, source, payload_hash, payload, state, created_at, updated_at
      ) VALUES (
        'runtime-exact-stale', 'caller-old', 'runtime-exact-stale-relation',
        'runtime-exact-stale-completion', 'runtime_followup',
        'claude_runtime_task_followup', 'runtime-exact-stale-hash',
        ${harness.sql.json({
          text: "stale attempt",
          user: "system",
          source: "claude_runtime_task_followup",
          followup_key: followupKey,
          followup_attempt: 1,
        })},
        'pending', ${createdAt}, ${createdAt}
      )
    `;
    const latest = registrations.find(
      (registration) => registration.deliveryId === rows[1]!.delivery_id,
    )!;
    await expect(repository.register(latest)).resolves.toMatchObject({
      inserted: false,
      conflict: false,
      row: { delivery_id: latest.deliveryId, state: "pending" },
    });
    await expect(repository.get("runtime-exact-stale")).resolves.toMatchObject({
      state: "superseded",
    });

    await repository.markConsumedByRelation(
      latest.relationKey,
      latest.completionId!,
      "event:equal-time",
    );
    for (const [suffix, attempt] of [["older", 2], ["latest", 3]] as const) {
      await harness.sql`
        INSERT INTO session_deliveries (
          delivery_id, target_session_id, relation_key, completion_id,
          intent, source, payload_hash, payload, state, created_at, updated_at
        ) VALUES (
          ${`runtime-terminal-replay-${suffix}`}, 'caller-old',
          ${`runtime-terminal-replay-relation-${suffix}`},
          ${`runtime-terminal-replay-completion-${suffix}`},
          'runtime_followup', 'claude_runtime_task_followup',
          ${`runtime-terminal-replay-hash-${suffix}`},
          ${harness.sql.json({
            text: suffix,
            user: "system",
            source: "claude_runtime_task_followup",
            followup_key: followupKey,
            followup_attempt: attempt,
          })},
          'pending', ${createdAt}, ${createdAt}
        )
      `;
    }
    const exact = await repository.get(latest.deliveryId);
    expect(exact).toBeDefined();
    const gate = new TaskDeliveryLedgerGate(true, repository);
    await expect(gate.admit({
      agentSessionId: "caller-old",
      text: String(exact!.payload.text),
      user: "system",
      deliveryId: exact!.delivery_id,
      deliveryIntent: "runtime_followup",
      completionId: exact!.completion_id!,
      relationKey: exact!.relation_key,
      source: exact!.source,
      followupKey,
      followupAttempt: 2,
      storedDeliveryPayload: exact!.payload,
      storedDeliveryPayloadHash: exact!.payload_hash,
      deliveryCreatedAt: exact!.created_at.toISOString(),
    })).resolves.toEqual({
      kind: "suppressed",
      deliveryId: exact!.delivery_id,
      reason: "delivery_consumed",
    });
    await expect(repository.get("runtime-terminal-replay-older"))
      .resolves.toMatchObject({ state: "superseded" });
    await expect(repository.get("runtime-terminal-replay-latest"))
      .resolves.toMatchObject({ state: "pending" });
  });

  it("keeps attempt verdicts, aggregate state, and target receipts on separate layers", async () => {
    await register("delivery-accepted", "relation-accepted");
    await repository.claimForTarget("delivery-accepted", "caller-old", "worker-a");
    await repository.beginDispatch("delivery-accepted", "worker-a");
    await expect(repository.markQueued("delivery-accepted", "worker-a"))
      .resolves.toMatchObject({ aggregate_state: "pending" });
    await expect(repository.markDelivered("delivery-accepted", "event:501"))
      .resolves.toMatchObject({
        aggregate_state: "delivered",
        target_receipt_id: "event:501",
      });
    await expect(repository.markConsumed("delivery-accepted", "event:wrong"))
      .resolves.toBeNull();
    await expect(repository.markConsumed("delivery-accepted", "event:501"))
      .resolves.toMatchObject({ aggregate_state: "consumed" });

    await register("delivery-retryable", "relation-retryable");
    await repository.claimForTarget("delivery-retryable", "caller-old", "worker-b");
    await repository.beginDispatch("delivery-retryable", "worker-b");
    await expect(repository.retryLeasedDelivery(
      "delivery-retryable",
      "worker-b",
      "target busy",
      new Date(Date.now() + 1_000),
    )).resolves.toMatchObject({ aggregate_state: "pending" });

    await register("delivery-rejected", "relation-rejected");
    await repository.claimForTarget("delivery-rejected", "caller-old", "worker-c");
    await repository.beginDispatch("delivery-rejected", "worker-c");
    await expect(repository.markUncertain(
      "delivery-rejected",
      "worker-c",
      "invalid target acknowledgement",
    )).resolves.toMatchObject({
      aggregate_state: "dead_letter",
      attempt_count: 1,
    });

    await expect(harness.sql<Array<{
      delivery_id: string;
      outcome: string;
      lease_owner: string | null;
    }>>`
      SELECT delivery_id, outcome, lease_owner
      FROM session_delivery_attempts
      WHERE delivery_id IN (
        'delivery-accepted', 'delivery-retryable', 'delivery-rejected'
      )
      ORDER BY delivery_id
    `).resolves.toEqual([
      {
        delivery_id: "delivery-accepted",
        outcome: "accepted",
        lease_owner: "worker-a",
      },
      {
        delivery_id: "delivery-rejected",
        outcome: "rejected",
        lease_owner: "worker-c",
      },
      {
        delivery_id: "delivery-retryable",
        outcome: "retryable",
        lease_owner: "worker-b",
      },
    ]);
  });

  it("covers every intent × attempt outcome × aggregate state × receipt decision", async () => {
    const intents = [
      "durable_next_turn",
      "completion_notification",
      "runtime_followup",
    ] as const;
    const outcomes = ["accepted", "retryable", "rejected"] as const;
    const aggregates = ["pending", "delivered", "consumed", "dead_letter"] as const;
    const receiptOptions = [false, true] as const;
    const allowedNames = new Set<string>([
      "accepted:pending:false",
      "accepted:delivered:true",
      "accepted:consumed:true",
      "retryable:pending:false",
      "rejected:dead_letter:false",
    ]);
    let decisions = 0;
    let allowedDecisions = 0;

    for (const intent of intents) {
      for (const outcome of outcomes) {
        for (const aggregate of aggregates) {
          for (const hasReceipt of receiptOptions) {
            decisions += 1;
            const decisionKey = `${outcome}:${aggregate}:${hasReceipt}`;
            const allowed = allowedNames.has(decisionKey);
            expect(isDeliveryLayerCombinationAllowed({
              outcome,
              aggregateState: aggregate,
              hasTargetReceipt: hasReceipt,
            }), `${intent}:${decisionKey}`).toBe(allowed);
            if (!allowed) continue;
            allowedDecisions += 1;
            const deliveryId = `matrix-${intent}-${outcome}-${aggregate}-${hasReceipt}`;
            const receipt = hasReceipt ? `event:${deliveryId}` : null;
        await register(deliveryId, `relation-${deliveryId}`, intent);
        await repository.claimForTarget(deliveryId, "caller-old", `worker-${deliveryId}`);
        await repository.beginDispatch(deliveryId, `worker-${deliveryId}`);
            if (outcome === "accepted" && aggregate === "pending") {
          await repository.markQueued(deliveryId, `worker-${deliveryId}`);
            } else if (outcome === "accepted" && aggregate === "delivered") {
          await repository.markQueued(deliveryId, `worker-${deliveryId}`);
              await repository.markDelivered(deliveryId, receipt!);
            } else if (outcome === "accepted" && aggregate === "consumed") {
          await repository.markQueued(deliveryId, `worker-${deliveryId}`);
              await repository.markDelivered(deliveryId, receipt!);
              await repository.markConsumed(deliveryId, receipt!);
            } else if (outcome === "retryable") {
          await repository.retryLeasedDelivery(
            deliveryId,
            `worker-${deliveryId}`,
            "retryable",
            new Date(Date.now() + 1_000),
          );
            } else {
          await repository.markUncertain(
            deliveryId,
            `worker-${deliveryId}`,
            "rejected",
          );
        }

        await expect(repository.get(deliveryId)).resolves.toMatchObject({
          intent,
              aggregate_state: aggregate,
              target_receipt_id: receipt,
        });
        await expect(harness.sql<Array<{ outcome: string; target_receipt_id: string | null }>>`
          SELECT outcome, target_receipt_id
          FROM session_delivery_attempts
          WHERE delivery_id = ${deliveryId}
          ORDER BY attempt_number DESC
          LIMIT 1
        `).resolves.toEqual([{
              outcome,
          target_receipt_id: null,
        }]);
          }
        }
      }
    }
    expect(decisions).toBe(3 * 3 * 4 * 2);
    expect(allowedDecisions).toBe(3 * 5);
  });

  it("backfills legacy delivered rows only when a target receipt exists", async () => {
    await register("legacy-with-receipt", "relation-legacy-with-receipt");
    await register("legacy-missing-receipt", "relation-legacy-missing-receipt");
    await register("legacy-budget-exhausted", "relation-legacy-budget-exhausted");
    await harness.sql`
      UPDATE session_deliveries
      SET state = 'delivered'
      WHERE delivery_id IN ('legacy-with-receipt', 'legacy-missing-receipt')
    `;
    await harness.sql`
      UPDATE session_deliveries
      SET state = 'uncertain', attempt_count = 15,
          created_at = NOW() - INTERVAL '25 hours'
      WHERE delivery_id = 'legacy-budget-exhausted'
    `;
    await harness.sql`
      INSERT INTO session_delivery_notification_outbox (
        delivery_id, target_session_id, payload, disposition, state,
        projection_state, target_receipt_id, target_receipt_at
      ) VALUES
        ('legacy-with-receipt', 'caller-old', '{}'::jsonb, 'queued', 'published',
         'published', 'event:legacy', NOW()),
        ('legacy-missing-receipt', 'caller-old', '{}'::jsonb, 'queued', 'published',
         'published', NULL, NULL)
    `;

    const migration = readFileSync(new URL(
      "../../../packages/db-schema/sql/migrations/067_execution_ownership_delivery_convergence.sql",
      import.meta.url,
    ), "utf8");
    await harness.sql.unsafe(migration);

    await expect(harness.sql<Array<{
      delivery_id: string;
      aggregate_state: string;
      target_receipt_id: string | null;
    }>>`
      SELECT delivery_id, aggregate_state, target_receipt_id
      FROM session_deliveries
      WHERE delivery_id LIKE 'legacy-%'
      ORDER BY delivery_id
    `).resolves.toEqual([
      {
        delivery_id: "legacy-budget-exhausted",
        aggregate_state: "dead_letter",
        target_receipt_id: null,
      },
      {
        delivery_id: "legacy-missing-receipt",
        aggregate_state: "pending",
        target_receipt_id: null,
      },
      {
        delivery_id: "legacy-with-receipt",
        aggregate_state: "delivered",
        target_receipt_id: "event:legacy",
      },
    ]);
    await expect(harness.sql<Array<{ delivery_id: string; outcome: string }>>`
      SELECT delivery_id, outcome
      FROM session_delivery_attempts
      WHERE delivery_id LIKE 'legacy-%'
      ORDER BY delivery_id
    `).resolves.toEqual([
      { delivery_id: "legacy-budget-exhausted", outcome: "rejected" },
      { delivery_id: "legacy-missing-receipt", outcome: "retryable" },
      { delivery_id: "legacy-with-receipt", outcome: "accepted" },
    ]);
    await expect(harness.sql<Array<{
      delivery_id: string;
      state: string;
      projection_state: string;
    }>>`
      SELECT delivery_id, state, projection_state
      FROM session_delivery_notification_outbox
      WHERE delivery_id = 'legacy-missing-receipt'
    `).resolves.toEqual([{
      delivery_id: "legacy-missing-receipt",
      state: "pending",
      projection_state: "staged",
    }]);
  });

  async function register(
    deliveryId: string,
    relationKey: string,
    intent: "durable_next_turn" | "completion_notification" | "runtime_followup" =
      "completion_notification",
  ): Promise<void> {
    await repository.register({
      deliveryId,
      targetSessionId: "caller-old",
      sourceSessionId: "child-session",
      relationKey,
      completionId: `completion-${relationKey}`,
      intent,
      source: "completion_notifier",
      producerKind: "child_session",
      producerId: "child-session",
      producerTerminalRevision: "42",
      payloadHash: `hash-${relationKey}`,
      payload: { text: "done" },
    });
  }

});

function silentLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}

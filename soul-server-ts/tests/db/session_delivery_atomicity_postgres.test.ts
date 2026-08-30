import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDeliveryRepository } from "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import type { SqlClient } from "../../src/db/session_db.js";
import { runnerRequestFrame } from "../../src/runner/frame_protocol.js";
import { RunnerProcessDispatcher } from
  "../../src/runner/runner_process_dispatcher.js";
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
      await transactional.markConsumedByRelation({
        deliveryId: "delivery-consume-first",
        relationKey: "relation-consume-first",
        completionId: "completion-relation-consume-first",
        callerSessionId: "caller-old",
        consumedTurnId: "turn-inline",
      });
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
      blockedConsume = repository.markConsumedByRelation({
        deliveryId: "delivery-dispatch-first",
        relationKey: "relation-dispatch-first",
        completionId: "completion-relation-dispatch-first",
        callerSessionId: "caller-old",
        consumedTurnId: "turn-inline",
      });
      await new Promise((resolve) => setImmediate(resolve));
      await expect(transactional.beginDispatch("delivery-dispatch-first"))
        .resolves.toMatchObject({ state: "dispatching" });
    });
    await expect(blockedConsume).resolves.toMatchObject({ deliveryConsumed: true });
    expect((await repository.get("delivery-dispatch-first"))?.state)
      .toBe("consumed");

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
      blockedQueuedConsume = repository.markConsumedByRelation({
        deliveryId: "delivery-queued-first",
        relationKey: "relation-queued-first",
        completionId: "completion-relation-queued-first",
        callerSessionId: "caller-old",
        consumedTurnId: "turn-inline-late",
      });
      await new Promise((resolve) => setImmediate(resolve));
      await expect(transactional.beginDispatch("delivery-queued-first"))
        .resolves.toMatchObject({ state: "dispatching" });
      await expect(transactional.markQueued("delivery-queued-first"))
        .resolves.toMatchObject({ state: "queued" });
    });
    await expect(blockedQueuedConsume).resolves.toMatchObject({ deliveryConsumed: true });
    expect((await repository.get("delivery-queued-first"))?.state).toBe("consumed");
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

    await repository.markConsumedByRelation({
      deliveryId: "delivery-projection-discard",
      relationKey: "relation-projection-discard",
      completionId: "completion-relation-projection-discard",
      callerSessionId: "caller-old",
      consumedTurnId: "event:projection-consumed",
    });

    await expect(repository.get("delivery-projection-discard")).resolves.toMatchObject({
      state: "consumed",
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

  it("[A2 durability] responds before activation failure returns the real notification row to pending", async () => {
    const deliveryId = "delivery-a2-post-response-retry";
    const leaseOwner = "route-a2-post-response";
    await repository.register({
      deliveryId,
      targetSessionId: "caller-old",
      sourceSessionId: "child-session",
      relationKey: "relation-a2-post-response-retry",
      completionId: "completion-relation-a2-post-response-retry",
      intent: "completion_notification",
      source: "completion_notifier",
      producerKind: "child_session",
      producerId: "child-session",
      producerTerminalRevision: "42",
      payloadHash: "hash-relation-a2-post-response-retry",
      payload: { text: "done", user: "agent", caller_info: null },
    });
    await repository.claimForTarget(deliveryId, "caller-old", leaseOwner);
    const dispatching = await repository.beginDispatch(deliveryId, leaseOwner);
    expect(dispatching).toMatchObject({
      delivery_id: deliveryId,
      state: "dispatching",
      lease_owner: leaseOwner,
    });
    const gate = new TaskDeliveryLedgerGate(true, repository);
    const sent: unknown[] = [];
    const order: string[] = [];
    const logger = silentLogger();
    const activationError = new Error("activation rejected after durable publish");
    const dispatcher = Object.create(RunnerProcessDispatcher.prototype) as
      RunnerProcessDispatcher & {
        handleHostRequest(frame: ReturnType<typeof runnerRequestFrame>): Promise<void>;
      };
    Object.assign(dispatcher, {
      options: {
        logger,
        handleHostCall: async (
          _call: unknown,
          registerPostResponse: (continuation: () => Promise<void>) => void,
        ) => {
          await gate.recordResult({
            kind: "admitted",
            deliveryId,
            row: dispatching!,
          }, { autoResumed: true });
          order.push("durable-publish");
          registerPostResponse(async () => {
            order.push("activation");
            expect(sent).toHaveLength(1);
            try {
              await Promise.reject(activationError);
            } catch (error) {
              await gate.recordNotificationFailure(
                { kind: "admitted", deliveryId, row: dispatching! },
                `auto-resume activation failed: ${(error as Error).message}`,
              );
              throw error;
            }
          });
          return null;
        },
      },
      recentHostResponses: new Map(),
      hostCallIdempotency: {
        execute: async (
          _call: unknown,
          apply: (idempotencyKey: string) => Promise<unknown>,
        ) => ({ data: await apply("host:a2-durability"), replayed: false }),
      },
      sendBestEffort: async (frame: unknown) => {
        order.push("response");
        sent.push(frame);
      },
    });

    await dispatcher.handleHostRequest(runnerRequestFrame("host:a2-durability", {
      kind: "host_call",
      service: "detached_event",
      operation: "publish",
      args: ["caller-old", { type: "text", text: "done", timestamp: 1 }],
    }));

    expect(order).toEqual(["durable-publish", "response", "activation"]);
    expect(sent).toEqual([
      expect.objectContaining({
        kind: "response",
        result: expect.objectContaining({ status: "ok" }),
      }),
    ]);
    await expect(harness.sql<Array<{
      delivery_id: string;
      delivery_state: string;
      aggregate_state: string;
      delivery_lease_owner: string | null;
      delivery_lease_expires_at: Date | null;
      delivery_last_error: string | null;
      notification_state: string;
      projection_state: string;
      notification_lease_owner: string | null;
      notification_lease_expires_at: Date | null;
      notification_attempt_count: number;
      notification_last_error: string | null;
    }>>`
      SELECT
        delivery.delivery_id,
        delivery.state AS delivery_state,
        delivery.aggregate_state,
        delivery.lease_owner AS delivery_lease_owner,
        delivery.lease_expires_at AS delivery_lease_expires_at,
        delivery.last_error AS delivery_last_error,
        notification.state AS notification_state,
        notification.projection_state,
        notification.lease_owner AS notification_lease_owner,
        notification.lease_expires_at AS notification_lease_expires_at,
        notification.attempt_count AS notification_attempt_count,
        notification.last_error AS notification_last_error
      FROM session_deliveries AS delivery
      JOIN session_delivery_notification_outbox AS notification
        USING (delivery_id)
      WHERE delivery.delivery_id = ${deliveryId}
    `).resolves.toEqual([{
      delivery_id: deliveryId,
      delivery_state: "queued",
      aggregate_state: "pending",
      // The queued aggregate keeps its dispatch lease by design; recovery
      // replaces stale ownership. See the expired same-owner contract below
      // ("stages an expired same-owner dispatch...", lines 589-635).
      delivery_lease_owner: leaseOwner,
      delivery_lease_expires_at: expect.any(Date),
      delivery_last_error:
        "auto-resume activation failed: activation rejected after durable publish",
      notification_state: "pending",
      projection_state: "staged",
      notification_lease_owner: null,
      notification_lease_expires_at: null,
      notification_attempt_count: 1,
      notification_last_error:
        "auto-resume activation failed: activation rejected after durable publish",
    }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "host:a2-durability",
        err: activationError,
      }),
      "Runner host post-response continuation failed; durable delivery remains pending",
    );
  });

  it("consumes a cross-node notification after the target lastEventId advances", async () => {
    const deliveryId = "delivery-advanced-target-receipt";
    const publishedReceiptId = "event:390";
    const consumedTurnId = "event:447";
    const leaseOwner = "cross-node-worker";
    await harness.sql`
      UPDATE sessions SET node_id = 'node-a' WHERE session_id = 'caller-old'
    `;
    await register(deliveryId, "relation-advanced-target-receipt");
    await repository.claimForTarget(deliveryId, "caller-old", leaseOwner);
    await repository.beginDispatch(deliveryId, leaseOwner);
    await repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      leaseOwner,
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload: {
        text: "done",
        user: "agent",
        source: "completion_notifier",
        delivery_id: deliveryId,
        delivery_intent: "completion_notification",
        completion_id: "completion-relation-advanced-target-receipt",
        relation_key: "relation-advanced-target-receipt",
        disposition: "auto_resume",
        caller_info: null,
      },
    });
    await repository.notifications.markPublished(
      deliveryId,
      leaseOwner,
      publishedReceiptId,
    );

    const gate = new TaskDeliveryLedgerGate(true, repository);
    const message = {
      text: "done",
      user: "agent",
      deliveryId,
      deliveryIntent: "completion_notification" as const,
      source: "completion_notifier",
      completionId: "completion-relation-advanced-target-receipt",
      relationKey: "relation-advanced-target-receipt",
    };
    const task = {
      agentSessionId: "caller-old",
      prompt: "delegate",
      status: "running" as const,
      lastEventId: 447,
      lastReadEventId: 390,
      interventionQueue: [],
      createdAt: new Date(),
    };

    await expect(gate.recordConsumed(message, task, consumedTurnId))
      .resolves.toBeUndefined();
    await expect(repository.get(deliveryId)).resolves.toMatchObject({
      state: "consumed",
      aggregate_state: "consumed",
      target_receipt_id: publishedReceiptId,
      caller_turn_id: consumedTurnId,
      consumed_at: expect.any(Date),
    });
    await expect(gate.recordConsumed(message, task, consumedTurnId))
      .resolves.toBeUndefined();
  });

  it("consumes a delivered notification with its exact relation receipt", async () => {
    const deliveryId = "delivery-relation-tombstone-recovery";
    const relationKey = "relation-tombstone-recovery";
    const completionId = `completion-${relationKey}`;
    const leaseOwner = "relation-recovery-worker";
    const publishedReceiptId = "event:555";
    const consumedTurnId = "event:626";
    await register(deliveryId, relationKey);
    await repository.claimForTarget(deliveryId, "caller-old", leaseOwner);
    await repository.beginDispatch(deliveryId, leaseOwner);
    await repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      leaseOwner,
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload: {
        text: "done",
        user: "agent",
        source: "completion_notifier",
        delivery_id: deliveryId,
        delivery_intent: "completion_notification",
        completion_id: completionId,
        relation_key: relationKey,
        disposition: "auto_resume",
        caller_info: null,
      },
    });
    await repository.notifications.markPublished(
      deliveryId,
      leaseOwner,
      publishedReceiptId,
    );
    await expect(repository.claimRecoverableCompletionDeliveries(
      "periodic-recovery",
    )).resolves.toHaveLength(0);
    await expect(repository.markConsumedByRelation({
      deliveryId,
      relationKey,
      completionId,
      callerSessionId: "caller-old",
      consumedTurnId,
    })).resolves.toMatchObject({
      relationInserted: true,
      deliveryConsumed: true,
    });
    await expect(repository.get(deliveryId)).resolves.toMatchObject({
      state: "consumed",
      aggregate_state: "consumed",
      target_receipt_id: publishedReceiptId,
      caller_turn_id: consumedTurnId,
      consumed_reason: "exact relation receipt",
      consumed_at: expect.any(Date),
    });

    const unrelatedId = "delivery-unrelated-delivered";
    await register(unrelatedId, "relation-unrelated-delivered");
    await repository.claimForTarget(unrelatedId, "caller-old");
    await repository.markDelivered(unrelatedId, "event:unrelated");
    await repository.claimRecoverableCompletionDeliveries("periodic-recovery");
    await expect(repository.get(unrelatedId)).resolves.toMatchObject({
      state: "delivered",
      aggregate_state: "delivered",
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
    await expect(repository.notifications.releaseExpiredLeases()).resolves.toBe(0);
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

  it("claims each registered terminal revision and rechecks its exact revision at dispatch", async () => {
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
    expect(recovered.map((row) => row.delivery_id)).toEqual([
      "delivery-revision-42",
      "delivery-revision-43",
    ]);
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

    const task = {
      agentSessionId: "caller-old",
      prompt: "",
      status: "completed" as const,
      lastEventId: 9,
      lastReadEventId: 0,
      interventionQueue: [],
      createdAt: new Date(),
    };
    const getTask = vi.fn().mockReturnValue(task);
    const queueOnly = vi.fn();
    const deliver = vi.fn();
    const resume = vi.fn();
    const publish = vi.fn();
    const wake = vi.fn();
    const route = new TaskInterventionRoute({
      getTask,
      loadEvictedTask: vi.fn(),
      rememberTask: vi.fn(),
      runningInterventionTransition: { queueOnly, deliver },
      autoResumeTransition: { resume },
      deliveryLedgerGate: gate,
      sessionNotificationPublisher: { publish },
    });

    await expect(route.addIntervention(params, wake)).resolves.toMatchObject({
      suppressed: true,
      reason: "delivery_consumed",
    });
    expect(getTask).toHaveBeenCalledOnce();
    expect(queueOnly).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("suppresses a late child notifier after inline consumption existed before its row", async () => {
    const gate = new TaskDeliveryLedgerGate(true, repository);
    const deliveryId = "delivery-late-child-notifier";
    const relationKey = "child_session:child-session:42";
    const completionId = "completion-inline-before-notifier";
    await harness.sql`
      UPDATE sessions
      SET caller_session_id = 'caller-old', last_event_id = 42
      WHERE session_id = 'child-session'
    `;
    await expect(repository.recordObservedChildCompletion({
      deliveryId,
      completionId,
      relationKey,
      callerSessionId: "caller-old",
      consumedTurnId: "event:44",
      childSessionId: "child-session",
      observedRevision: 42,
    })).resolves.toBe("recorded");

    const task = {
      agentSessionId: "caller-old",
      prompt: "delegate",
      status: "running" as const,
      lastEventId: 44,
      lastReadEventId: 0,
      interventionQueue: [],
      createdAt: new Date(),
    };
    const getTask = vi.fn().mockReturnValue(task);
    const queueOnly = vi.fn();
    const deliver = vi.fn();
    const resume = vi.fn();
    const publish = vi.fn();
    const wake = vi.fn();
    const route = new TaskInterventionRoute({
      getTask,
      loadEvictedTask: vi.fn(),
      rememberTask: vi.fn(),
      runningInterventionTransition: { queueOnly, deliver },
      autoResumeTransition: { resume },
      deliveryLedgerGate: gate,
      sessionNotificationPublisher: { publish },
    });
    const params = {
      agentSessionId: "caller-old",
      text: "late duplicate",
      user: "agent",
      deliveryId,
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
    expect(getTask).toHaveBeenCalledOnce();
    expect(queueOnly).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("lets an exact relation receipt consume every in-flight scheduling state", async () => {
    for (const state of ["pending", "claimed", "dispatching", "queued", "delivered"] as const) {
      const deliveryId = `delivery-exact-receipt-${state}`;
      const relationKey = `relation-exact-receipt-${state}`;
      await register(deliveryId, relationKey);
      if (state !== "pending") {
        await repository.claimForTarget(deliveryId, "caller-old", `worker-${state}`);
      }
      if (state === "dispatching" || state === "queued" || state === "delivered") {
        await repository.beginDispatch(deliveryId, `worker-${state}`);
      }
      if (state === "queued") {
        await repository.markQueued(deliveryId, `worker-${state}`);
      }
      if (state === "delivered") {
        await repository.markDelivered(deliveryId, `event:published-${state}`);
      }
      await expect(repository.markConsumedByRelation({
        deliveryId,
        relationKey,
        completionId: `completion-${relationKey}`,
        callerSessionId: "caller-old",
        consumedTurnId: `event:consumed-${state}`,
      })).resolves.toMatchObject({ deliveryConsumed: true });
      await expect(repository.get(deliveryId)).resolves.toMatchObject({
        state: "consumed",
        aggregate_state: "consumed",
        caller_turn_id: `event:consumed-${state}`,
      });
    }
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
    const receiptAuthority = readFileSync(new URL(
      "../../../packages/db-schema/sql/migrations/081_delivery_receipt_single_authority.sql",
      import.meta.url,
    ), "utf8");
    await harness.sql.unsafe(receiptAuthority);

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

  /**
   * 260820 incident: every retry path scheduled the next attempt without ever
   * consulting a budget, so three user messages reached 1,932 / 155 / 154
   * attempts with no terminal state and no dead-letter row.
   */
  it("schedules the next attempt on the database clock, not the caller's", async () => {
    await register("delivery-clock", "relation-clock", "durable_next_turn");
    await repository.claimForTarget("delivery-clock", "caller-old", "worker-clock");
    await repository.retryLeasedDelivery(
      "delivery-clock",
      "worker-clock",
      "target busy",
      60_000,
    );

    // The node clock ran 7.45s ahead of the host during the incident. A
    // duration is immune to that; an absolute instant was not.
    await expect(harness.sql<Array<{ delay_ms: number }>>`
      SELECT (EXTRACT(EPOCH FROM (next_attempt_at - NOW())) * 1000)::float8 AS delay_ms
      FROM session_deliveries WHERE delivery_id = 'delivery-clock'
    `).resolves.toMatchObject([
      { delay_ms: expect.closeTo(60_000, -3) },
    ]);
  });

  async function register(
    deliveryId: string,
    relationKey: string,
    intent: "durable_next_turn" | "completion_notification" | "runtime_followup"
      | "human_live_steer" =
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

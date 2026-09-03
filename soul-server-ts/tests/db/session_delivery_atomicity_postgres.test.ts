import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDeliveryRepository } from "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import { applyEventSessionEffect } from
  "../../../orch-server-ts/src/node/event_session_effect_applier.js";
import {
  DELIVERY_MAX_AGE_MS,
  DELIVERY_MAX_ATTEMPTS,
} from "../../../orch-server-ts/src/control_plane/repositories/session_delivery_retry_policy.js";
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
  let lockObserver: SqlClient;
  let repository: SessionDeliveryRepository;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    peer = harness.createPeer();
    lockObserver = harness.createPeer();
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
    await repository.claimAttemptForTarget("delivery-consume-first", "caller-old");

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
    await repository.claimAttemptForTarget("delivery-dispatch-first", "caller-old");
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
    await repository.claimAttemptForTarget("delivery-queued-first", "caller-old");
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
    await repository.claimAttemptForTarget(
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
      attempt_token: null,
      attempt_expires_at: null,
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
    await repository.claimAttemptForTarget(
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
      attemptToken: "projection-worker",
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

    await applyEventSessionEffect(harness.sql as never, {
      nodeId: "node-a",
      eventId: 43,
      envelope: { session_id: "child-session" },
      effect: {
        kind: "running_transition",
        review_state: "not_required",
        expected_terminal_event_id: 42,
        updated_at: new Date().toISOString(),
      },
    } as never);

    await expect(repository.get("delivery-projection-discard")).resolves.toMatchObject({
      state: "superseded",
      aggregate_state: "consumed",
    });
    await expect(harness.sql<Array<{
      state: string;
      projection_state: string;
      attempt_token: string | null;
    }>>`
      SELECT state, projection_state, attempt_token
      FROM session_delivery_notification_outbox
      WHERE delivery_id = 'delivery-projection-discard'
    `).resolves.toEqual([{
      state: "dead_letter",
      projection_state: "discarded",
      attempt_token: null,
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

  it("serializes notification publish behind consume without a cross-table deadlock", async () => {
    const deliveryId = "delivery-publish-consume-lock-order";
    const attemptToken = "projection-lock-order-worker";
    await register(deliveryId, "relation-publish-consume-lock-order");
    await repository.claimAttemptForTarget(deliveryId, "caller-old", attemptToken);
    await repository.beginDispatch(deliveryId, attemptToken);
    await repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      attemptToken,
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload: {
        text: "done",
        user: "agent",
        source: "completion_notifier",
        delivery_id: deliveryId,
        delivery_intent: "completion_notification",
        completion_id: "completion-publish-consume-lock-order",
        relation_key: "relation-publish-consume-lock-order",
        disposition: "auto_resume",
        caller_info: null,
      },
    });
    await harness.sql`SET application_name = 'r52-publish-lock-order'`;

    let published!: ReturnType<
      SessionDeliveryRepository["notifications"]["markPublished"]
    >;
    await peer.begin(async (transaction) => {
      const transactional = new SessionDeliveryRepository(
        transaction as unknown as SqlClient,
      );
      await transaction`
        SELECT 1 FROM session_deliveries
        WHERE delivery_id = ${deliveryId}
        FOR UPDATE
      `;
      published = repository.notifications.markPublished(
        deliveryId,
        attemptToken,
        "event:publish-race",
      );
      await waitForApplicationLock(lockObserver, "r52-publish-lock-order");
      await expect(transactional.markConsumed(deliveryId, "event:consume-race"))
        .resolves.toMatchObject({ aggregate_state: "consumed" });
    });

    await expect(published).resolves.toBeNull();
    await expect(repository.get(deliveryId)).resolves.toMatchObject({
      aggregate_state: "consumed",
    });
    await expect(repository.notifications.get(deliveryId)).resolves.toMatchObject({
      state: "dead_letter",
      projection_state: "discarded",
    });
  });

  it("projects an orphaned notification receipt when the same target turn already delivered the aggregate", async () => {
    const deliveryId = "delivery-orphaned-receipt";
    const targetReceiptId = "event:901";
    await register(deliveryId, "relation-orphaned-receipt");
    await repository.claimAttemptForTarget(deliveryId, "caller-old", "route-worker");
    await repository.beginDispatch(deliveryId, "route-worker");
    await repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      attemptToken: "route-worker",
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
    const attemptToken = "route-a2-post-response";
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
    await repository.claimAttemptForTarget(deliveryId, "caller-old", attemptToken);
    const dispatching = await repository.beginDispatch(deliveryId, attemptToken);
    expect(dispatching).toMatchObject({
      delivery_id: deliveryId,
      state: "dispatching",
      attempt_token: attemptToken,
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
      delivery_attempt_token: string | null;
      delivery_attempt_expires_at: Date | null;
      delivery_last_error: string | null;
      notification_state: string;
      projection_state: string;
      notification_attempt_token: string | null;
      notification_attempt_expires_at: Date | null;
      notification_attempt_count: number;
      notification_last_error: string | null;
    }>>`
      SELECT
        delivery.delivery_id,
        delivery.state AS delivery_state,
        delivery.aggregate_state,
        delivery.attempt_token AS delivery_attempt_token,
        delivery.attempt_expires_at AS delivery_attempt_expires_at,
        delivery.last_error AS delivery_last_error,
        notification.state AS notification_state,
        notification.projection_state,
        notification.attempt_token AS notification_attempt_token,
        notification.attempt_expires_at AS notification_attempt_expires_at,
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
      // The queued aggregate keeps its dispatch attempt token by design;
      // recovery replaces a stale token. See the expired-token contract below.
      delivery_attempt_token: attemptToken,
      delivery_attempt_expires_at: expect.any(Date),
      delivery_last_error:
        "auto-resume activation failed: activation rejected after durable publish",
      notification_state: "pending",
      projection_state: "staged",
      notification_attempt_token: null,
      notification_attempt_expires_at: null,
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
    const attemptToken = "cross-node-worker";
    await harness.sql`
      UPDATE sessions SET node_id = 'node-a' WHERE session_id = 'caller-old'
    `;
    await register(deliveryId, "relation-advanced-target-receipt");
    await repository.claimAttemptForTarget(deliveryId, "caller-old", attemptToken);
    await repository.beginDispatch(deliveryId, attemptToken);
    await repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      attemptToken,
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
      attemptToken,
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

  it("recovers a delivered notification from its exact relation tombstone", async () => {
    const deliveryId = "delivery-relation-tombstone-recovery";
    const relationKey = "relation-tombstone-recovery";
    const completionId = `completion-${relationKey}`;
    const attemptToken = "relation-recovery-worker";
    const publishedReceiptId = "event:555";
    const consumedTurnId = "event:626";
    await register(deliveryId, relationKey);
    await repository.claimAttemptForTarget(deliveryId, "caller-old", attemptToken);
    await repository.beginDispatch(deliveryId, attemptToken);
    await repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      attemptToken,
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
      attemptToken,
      publishedReceiptId,
    );
    await harness.sql`
      INSERT INTO session_delivery_relation_consumptions (
        relation_key, completion_id, caller_session_id, consumed_turn_id
      ) VALUES (
        ${relationKey}, ${completionId}, 'caller-old', ${consumedTurnId}
      )
    `;

    await expect(repository.claimRecoverableCompletionDeliveries(
      "periodic-recovery",
    )).resolves.toEqual([]);
    await expect(repository.get(deliveryId)).resolves.toMatchObject({
      state: "consumed",
      aggregate_state: "consumed",
      target_receipt_id: publishedReceiptId,
      caller_turn_id: consumedTurnId,
      consumed_reason: "exact relation receipt recovery",
      consumed_at: expect.any(Date),
    });

    const unrelatedId = "delivery-unrelated-delivered";
    await register(unrelatedId, "relation-unrelated-delivered");
    await repository.claimAttemptForTarget(unrelatedId, "caller-old");
    await repository.markDelivered(unrelatedId, "event:unrelated");
    await repository.claimRecoverableCompletionDeliveries("periodic-recovery");
    await expect(repository.get(unrelatedId)).resolves.toMatchObject({
      state: "delivered",
      aggregate_state: "delivered",
    });
  });

  it("stages an expired same-token dispatch and rejects the replaced token", async () => {
    await harness.sql`
      UPDATE sessions SET node_id = 'node-a' WHERE session_id = 'caller-old'
    `;
    await register("delivery-expired-stage", "relation-expired-stage");
    await repository.claimAttemptForTarget(
      "delivery-expired-stage",
      "caller-old",
      "worker-original",
    );
    await repository.beginDispatch("delivery-expired-stage", "worker-original");
    await harness.sql`
      UPDATE session_deliveries
      SET attempt_expires_at = NOW() - INTERVAL '1 second'
      WHERE delivery_id = 'delivery-expired-stage'
    `;

    await expect(repository.notifications.stageWithQueuedDelivery({
      deliveryId: "delivery-expired-stage",
      attemptToken: "worker-original",
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
    await expect(harness.sql<Array<{ attempt_is_fresh: boolean }>>`
      SELECT attempt_expires_at > NOW() AS attempt_is_fresh
      FROM session_delivery_notification_outbox
      WHERE delivery_id = 'delivery-expired-stage'
    `).resolves.toEqual([{ attempt_is_fresh: true }]);
    await expect(repository.notifications.expireStaleNotificationAttempts(
      4,
      new Date(0),
    )).resolves.toBe(0);
    await expect(repository.notifications.claimDue(
      "node-a",
      "notification-recovery",
    )).resolves.toEqual([]);

    await register("delivery-replaced-token", "relation-replaced-token");
    await repository.claimAttemptForTarget(
      "delivery-replaced-token",
      "caller-old",
      "worker-old",
    );
    await repository.beginDispatch("delivery-replaced-token", "worker-old");
    await harness.sql`
      UPDATE session_deliveries
      SET attempt_token = 'worker-new'
      WHERE delivery_id = 'delivery-replaced-token'
    `;
    await expect(repository.notifications.stageWithQueuedDelivery({
      deliveryId: "delivery-replaced-token",
      attemptToken: "worker-old",
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload: {
        text: "done",
        user: "agent",
        source: "completion_notifier",
        delivery_id: "delivery-replaced-token",
        delivery_intent: "completion_notification",
        completion_id: "completion-relation-replaced-token",
        relation_key: "relation-replaced-token",
        disposition: "auto_resume",
        caller_info: null,
      },
    })).resolves.toBeNull();
  });

  it("reclaims a stale notification outbox for the exact same delivery identity", async () => {
    const deliveryId = "delivery-stale-outbox-retry";
    const relationKey = "relation-stale-outbox-retry";
    const payload = notificationPayload(deliveryId, relationKey);
    await register(deliveryId, relationKey);
    await repository.claimAttemptForTarget(deliveryId, "caller-old", "worker-old");
    await repository.beginDispatch(deliveryId, "worker-old");
    await repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      attemptToken: "worker-old",
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload,
    }, 0);
    await repository.retryDeliveryAttempt(
      deliveryId,
      "worker-old",
      "worker stopped before publish",
      0,
    );
    await repository.claimAttemptForTarget(deliveryId, "caller-old", "worker-retry");
    await repository.beginDispatch(deliveryId, "worker-retry");

    await expect(repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      attemptToken: "worker-retry",
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload,
    })).resolves.toMatchObject({
      delivery_id: deliveryId,
      state: "queued",
    });
    await expect(repository.notifications.get(deliveryId)).resolves.toMatchObject({
      delivery_id: deliveryId,
      state: "claimed",
      projection_state: "publishing",
      attempt_token: "worker-retry",
      payload: expect.objectContaining({
        delivery_id: deliveryId,
        completion_id: "completion-" + relationKey,
        relation_key: relationKey,
      }),
    });
  });

  it("treats an exact staged outbox as idempotent while its first writer is live", async () => {
    const deliveryId = "delivery-live-outbox-writer";
    const relationKey = "relation-live-outbox-writer";
    const payload = notificationPayload(deliveryId, relationKey);
    await register(deliveryId, relationKey);
    await repository.claimAttemptForTarget(deliveryId, "caller-old", "worker-live");
    await repository.beginDispatch(deliveryId, "worker-live");
    await repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      attemptToken: "worker-live",
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload,
    });
    await repository.retryDeliveryAttempt(
      deliveryId,
      "worker-live",
      "delivery retry raced live notification writer",
      0,
    );
    await repository.claimAttemptForTarget(deliveryId, "caller-old", "worker-racing");
    await repository.beginDispatch(deliveryId, "worker-racing");
    const [{ count: attemptsBefore }] = await harness.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM session_delivery_attempts
      WHERE delivery_id = ${deliveryId}
    `;

    await expect(repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      attemptToken: "worker-racing",
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload,
    })).resolves.toMatchObject({
      delivery_id: deliveryId,
      state: "queued",
      aggregate_state: "pending",
    });
    await expect(repository.get(deliveryId)).resolves.toMatchObject({
      state: "queued",
      attempt_token: "worker-racing",
    });
    await expect(repository.notifications.get(deliveryId)).resolves.toMatchObject({
      state: "claimed",
      attempt_token: "worker-live",
    });
    await expect(harness.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM session_delivery_attempts
      WHERE delivery_id = ${deliveryId}
    `).resolves.toEqual([{ count: attemptsBefore }]);
  });

  it("rejects a live outbox retry when the staged notification payload differs", async () => {
    const deliveryId = "delivery-live-outbox-payload-mismatch";
    const relationKey = "relation-live-outbox-payload-mismatch";
    const payload = notificationPayload(deliveryId, relationKey);
    await register(deliveryId, relationKey);
    await repository.claimAttemptForTarget(deliveryId, "caller-old", "worker-live");
    await repository.beginDispatch(deliveryId, "worker-live");
    await repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      attemptToken: "worker-live",
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload,
    });
    await repository.retryDeliveryAttempt(
      deliveryId,
      "worker-live",
      "delivery retry raced live notification writer",
      0,
    );
    await repository.claimAttemptForTarget(deliveryId, "caller-old", "worker-racing");
    await repository.beginDispatch(deliveryId, "worker-racing");

    await expect(repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      attemptToken: "worker-racing",
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload: { ...payload, text: "different notification body" },
    })).rejects.toThrow("notification outbox already exists: " + deliveryId);
    await expect(repository.notifications.get(deliveryId)).resolves.toMatchObject({
      state: "claimed",
      attempt_token: "worker-live",
      payload: expect.objectContaining({ text: payload.text }),
    });
  });

  it("treats exact delivered and consumed notification stages as idempotent no-ops", async () => {
    const deliveryId = "delivery-terminal-stage-noop";
    const relationKey = "relation-terminal-stage-noop";
    const attemptToken = "worker-terminal-stage";
    const payload = notificationPayload(deliveryId, relationKey);
    const stage = () => repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      attemptToken,
      targetSessionId: "caller-old",
      disposition: "auto_resume" as const,
      payload,
    });
    await register(deliveryId, relationKey);
    await repository.claimAttemptForTarget(
      deliveryId,
      "caller-old",
      attemptToken,
    );
    await repository.beginDispatch(deliveryId, attemptToken);
    await expect(stage()).resolves.toMatchObject({ state: "queued" });
    await repository.notifications.markPublished(
      deliveryId,
      attemptToken,
      "event:terminal-stage",
    );
    const [{ count: attemptsBefore }] = await harness.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM session_delivery_attempts
      WHERE delivery_id = ${deliveryId}
    `;

    await expect(stage()).resolves.toMatchObject({
      state: "delivered",
      aggregate_state: "delivered",
    });
    await repository.markConsumed(deliveryId, "turn:terminal-stage");
    await expect(stage()).resolves.toMatchObject({
      state: "consumed",
      aggregate_state: "consumed",
    });
    await expect(harness.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM session_delivery_attempts
      WHERE delivery_id = ${deliveryId}
    `).resolves.toEqual([{ count: attemptsBefore }]);
  });

  it("rejects a stale outbox retry with a competing delivery identity", async () => {
    const deliveryId = "delivery-stale-outbox-identity";
    const relationKey = "relation-stale-outbox-identity";
    await register(deliveryId, relationKey);
    await repository.claimAttemptForTarget(deliveryId, "caller-old", "worker-old");
    await repository.beginDispatch(deliveryId, "worker-old");
    await repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      attemptToken: "worker-old",
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload: notificationPayload(deliveryId, relationKey),
    }, 0);
    await repository.retryDeliveryAttempt(
      deliveryId,
      "worker-old",
      "worker stopped before publish",
      0,
    );
    await repository.claimAttemptForTarget(deliveryId, "caller-old", "worker-retry");
    await repository.beginDispatch(deliveryId, "worker-retry");

    await expect(repository.notifications.stageWithQueuedDelivery({
      deliveryId,
      attemptToken: "worker-retry",
      targetSessionId: "caller-old",
      disposition: "auto_resume",
      payload: notificationPayload(
        deliveryId,
        relationKey,
        "completion-competing-writer",
      ),
    })).rejects.toThrow("notification outbox already exists: " + deliveryId);
    await expect(repository.get(deliveryId)).resolves.toMatchObject({
      state: "dispatching",
      attempt_token: "worker-retry",
    });
    await expect(repository.notifications.get(deliveryId)).resolves.toMatchObject({
      payload: expect.objectContaining({
        completion_id: "completion-" + relationKey,
      }),
    });
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
    await repository.claimAttemptForTarget(
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
    const task = {
      agentSessionId: "caller-old",
      prompt: "",
      status: "completed" as const,
      lastEventId: 9,
      lastReadEventId: 0,
      interventionQueue: [],
      createdAt: new Date(),
    };
    await expect(gate.admit(params)).resolves.toMatchObject({
      kind: "admitted",
      deliveryId: "delivery-consumed-e2e",
    });
    await gate.recordConsumed(params, task);

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
    expect(getTask).toHaveBeenCalledOnce();
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
    await repository.claimAttemptForTarget("delivery-accepted", "caller-old", "worker-a");
    await repository.beginDispatch("delivery-accepted", "worker-a");
    await expect(repository.markQueued("delivery-accepted", "worker-a"))
      .resolves.toMatchObject({ aggregate_state: "pending" });
    await expect(repository.markDelivered("delivery-accepted", "event:501"))
      .resolves.toMatchObject({
        aggregate_state: "delivered",
        target_receipt_id: "event:501",
      });
    await expect(repository.markConsumed("delivery-accepted", "event:502"))
      .resolves.toMatchObject({
        aggregate_state: "consumed",
        target_receipt_id: "event:501",
        caller_turn_id: "event:502",
      });

    await register("delivery-retryable", "relation-retryable");
    await repository.claimAttemptForTarget("delivery-retryable", "caller-old", "worker-b");
    await repository.beginDispatch("delivery-retryable", "worker-b");
    await repository.markQueued("delivery-retryable", "worker-b");
    await expect(repository.retryDeliveryAttempt(
      "delivery-retryable",
      "worker-b",
      "target busy",
      1_000,
    )).resolves.toMatchObject({ aggregate_state: "pending" });

    await register("delivery-rejected", "relation-rejected");
    await repository.claimAttemptForTarget("delivery-rejected", "caller-old", "worker-c");
    await repository.beginDispatch("delivery-rejected", "worker-c");
    await repository.markQueued("delivery-rejected", "worker-c");
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
      attempt_token: string | null;
    }>>`
      SELECT delivery_id, outcome, attempt_token
      FROM session_delivery_attempts
      WHERE delivery_id IN (
        'delivery-accepted', 'delivery-retryable', 'delivery-rejected'
      )
      ORDER BY delivery_id, attempt_number
    `).resolves.toEqual([
      {
        delivery_id: "delivery-accepted",
        outcome: "accepted",
        attempt_token: "worker-a",
      },
      {
        delivery_id: "delivery-rejected",
        outcome: "accepted",
        attempt_token: "worker-c",
      },
      {
        delivery_id: "delivery-rejected",
        outcome: "rejected",
        attempt_token: "worker-c",
      },
      {
        delivery_id: "delivery-retryable",
        outcome: "accepted",
        attempt_token: "worker-b",
      },
      {
        delivery_id: "delivery-retryable",
        outcome: "retryable",
        attempt_token: "worker-b",
      },
    ]);
  });

  it.each([
    "completion_notification",
    "human_live_steer",
  ] as const)(
    "keeps failed %s delivery replayable until one successful resume consumes it",
    async (intent) => {
      const deliveryId = `delivery-failed-replay-${intent}`;
      const relationKey = `relation-failed-replay-${intent}`;
      await register(deliveryId, relationKey, intent);
      const gate = new TaskDeliveryLedgerGate(true, repository);
      const request = {
        agentSessionId: "caller-old",
        text: "retry the same input",
        user: "user",
        deliveryId,
        deliveryIntent: intent,
        completionId: `completion-${relationKey}`,
        relationKey,
        source: intent === "completion_notification"
          ? "completion_notifier"
          : "user_message",
      };

      const firstAdmission = await gate.beginDispatch(await gate.admit({
        ...request,
        deliveryAttemptToken: "route-first",
      }));
      expect(firstAdmission.kind).toBe("admitted");
      await gate.recordResult(firstAdmission, { delivered: true });

      await expect(repository.get(deliveryId)).resolves.toMatchObject({
        state: "queued",
        aggregate_state: "pending",
        consumed_at: null,
      });

      const recovered = await repository.recovery.claimRecoverableQueued(
        {
          recoveryNodeId: "recovery-node",
          staleNodeAfterMs: 0,
          queuedAfterMs: 0,
        },
        "recovery-worker",
        10,
        15_000,
      );
      expect(recovered.map((row) => row.delivery_id)).toContain(deliveryId);
      await expect(repository.retryDeliveryAttempt(
        deliveryId,
        "recovery-worker",
        "failed turn kept for explicit resume",
        0,
      )).resolves.toMatchObject({
        state: "pending",
        aggregate_state: "pending",
      });

      const resumeAdmission = await gate.beginDispatch(await gate.admit({
        ...request,
        deliveryAttemptToken: "route-resume",
      }));
      expect(resumeAdmission.kind).toBe("admitted");
      await expect(repository.markQueued(
        deliveryId,
        "route-resume",
      )).resolves.toMatchObject({
        state: "queued",
        aggregate_state: "pending",
      });
      await expect(repository.markConsumed(
        deliveryId,
        "event:resume-success",
      )).resolves.toMatchObject({
        state: "consumed",
        aggregate_state: "consumed",
        target_receipt_id: "event:resume-success",
        caller_turn_id: "event:resume-success",
      });
      await expect(repository.markConsumed(
        deliveryId,
        "event:duplicate",
      )).resolves.toBeNull();
      await expect(gate.admit(request)).resolves.toEqual({
        kind: "suppressed",
        deliveryId,
        reason: "delivery_consumed",
      });
    },
  );

  it("consumes every active delivery once a turn supplies exact observation", async () => {
    for (const state of [
      "pending",
      "claimed",
      "dispatching",
      "queued",
      "delivered",
    ] as const) {
      const deliveryId = `delivery-consume-observed-${state}`;
      const attemptToken = `worker-${state}`;
      await register(deliveryId, `relation-consume-observed-${state}`);
      if (state !== "pending") {
        await repository.claimAttemptForTarget(
          deliveryId,
          "caller-old",
          attemptToken,
        );
      }
      if (state === "dispatching" || state === "queued" || state === "delivered") {
        await repository.beginDispatch(deliveryId, attemptToken);
      }
      if (state === "queued") {
        await repository.markQueued(deliveryId, attemptToken);
      }
      if (state === "delivered") {
        await repository.markDelivered(deliveryId, "event:transcript-proof");
      }

      await expect(repository.markConsumed(
        deliveryId,
        `event:observed-${state}`,
      )).resolves.toMatchObject({
        state: "consumed",
        aggregate_state: "consumed",
        caller_turn_id: `event:observed-${state}`,
      });
    }
  });

  it("terminalizes turn-observed input after its dispatch attempt expires", async () => {
    const deliveryId = "delivery-consume-after-attempt-expiry";
    await register(
      deliveryId,
      "relation-consume-after-attempt-expiry",
      "runtime_followup",
    );
    await repository.claimAttemptForTarget(
      deliveryId,
      "caller-old",
      "expired-attempt",
      60_000,
    );
    await repository.beginDispatch(deliveryId, "expired-attempt");
    await harness.sql`
      UPDATE session_deliveries
      SET attempt_expires_at = NOW() - INTERVAL '1 second'
      WHERE delivery_id = ${deliveryId}
    `;

    await expect(repository.expireStaleDeliveryAttempts()).resolves.toBe(1);
    await expect(repository.get(deliveryId)).resolves.toMatchObject({
      state: "pending",
      aggregate_state: "pending",
      last_error: "delivery attempt expired",
    });
    await harness.sql`
      UPDATE session_deliveries
      SET next_attempt_at = NOW() - INTERVAL '1 second'
      WHERE delivery_id = ${deliveryId}
    `;

    const gate = new TaskDeliveryLedgerGate(true, repository);
    await expect(gate.recordConsumed({
      text: "turn already observed this follow-up",
      user: "system",
      source: "claude_runtime_task_followup",
      deliveryId,
      deliveryIntent: "runtime_followup",
    }, {
      agentSessionId: "caller-old",
      prompt: "run",
      status: "running",
      createdAt: new Date(),
      lastEventId: 502,
      lastReadEventId: 0,
      interventionQueue: [],
    }, "event:observed-after-expiry")).resolves.toBeUndefined();

    await expect(repository.get(deliveryId)).resolves.toMatchObject({
      state: "consumed",
      aggregate_state: "consumed",
      caller_turn_id: "event:observed-after-expiry",
    });
    const replay = await repository.recovery.claimRecoverableCompletionDeliveries(
      "recovery-after-observation",
      10,
      15_000,
    );
    expect(replay.map((row) => row.delivery_id)).not.toContain(deliveryId);
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
        await repository.claimAttemptForTarget(deliveryId, "caller-old", `worker-${deliveryId}`);
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
          await repository.retryDeliveryAttempt(
            deliveryId,
            `worker-${deliveryId}`,
            "retryable",
            1_000,
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

    await harness.sql.unsafe(`
      DROP TRIGGER IF EXISTS trg_session_discard_notification_projection
        ON session_deliveries;
      DROP FUNCTION IF EXISTS session_discard_notification_projection_on_consumed();
      ALTER TABLE session_deliveries
        RENAME COLUMN attempt_token TO lease_owner;
      ALTER TABLE session_deliveries
        RENAME COLUMN attempt_expires_at TO lease_expires_at;
      ALTER TABLE session_delivery_notification_outbox
        RENAME COLUMN attempt_token TO lease_owner;
      ALTER TABLE session_delivery_notification_outbox
        RENAME COLUMN attempt_expires_at TO lease_expires_at;
      ALTER TABLE session_delivery_attempts
        RENAME COLUMN attempt_token TO lease_owner;
    `);
    const migration = readFileSync(new URL(
      "../../../packages/db-schema/sql/migrations/067_execution_ownership_delivery_convergence.sql",
      import.meta.url,
    ), "utf8");
    await harness.sql.unsafe(migration);
    const terminologyMigration = readFileSync(new URL(
      "../../../packages/db-schema/sql/migrations/086_delivery_attempt_terminology.sql",
      import.meta.url,
    ), "utf8");
    await harness.sql.unsafe(terminologyMigration);

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
  it("dead-letters a delivery once its retry budget is spent", async () => {
    await register("delivery-budget", "relation-budget", "durable_next_turn");
    await harness.sql`
      UPDATE session_deliveries
      SET attempt_count = ${DELIVERY_MAX_ATTEMPTS - 1}
      WHERE delivery_id = 'delivery-budget'
    `;
    await repository.claimAttemptForTarget("delivery-budget", "caller-old", "worker-budget");

    await expect(repository.retryDeliveryAttempt(
      "delivery-budget",
      "worker-budget",
      "target busy",
      1_000,
    )).resolves.toMatchObject({
      state: "uncertain",
      aggregate_state: "dead_letter",
      dead_letter_reason: "target busy",
    });

    await expect(harness.sql<Array<{ outcome: string; reason: string }>>`
      SELECT outcome, reason FROM session_delivery_attempts
      WHERE delivery_id = 'delivery-budget'
      ORDER BY attempt_number DESC LIMIT 1
    `).resolves.toMatchObject([{ outcome: "rejected", reason: "target busy" }]);

    // A dead-lettered delivery is terminal: the recovery scan must not pick it
    // up again, which is what kept the incident's rows retrying forever.
    await expect(repository.recovery.claimRecoverableCompletionDeliveries(
      "worker-after",
      10,
      1_000,
    )).resolves.toHaveLength(0);
  });

  /**
   * 260820 follow-up: transcript re-checks poll on a one-second cadence. If
   * they spent the delivery budget, a target node being quiet for two minutes
   * would dead-letter a good user message in about eighty seconds — the exact
   * loss the budget exists to prevent.
   */
  it("does not spend the delivery budget on transcript liveness probes", async () => {
    await register("delivery-probe", "relation-probe", "durable_next_turn");
    await harness.sql`
      UPDATE session_deliveries
      SET attempt_count = ${DELIVERY_MAX_ATTEMPTS - 1}
      WHERE delivery_id = 'delivery-probe'
    `;
    await repository.claimAttemptForTarget("delivery-probe", "caller-old", "worker-probe");

    // The real cycle is claim -> probe -> back to queued, repeating once a
    // second for as long as the transcript stays unsettled.
    for (let probe = 0; probe < 5; probe += 1) {
      await expect(repository.recovery.deferQueuedTranscriptCheck(
        "delivery-probe",
        "worker-probe",
        "queued_transcript_input_pending",
        1_000,
      )).resolves.toMatchObject({ state: "queued", aggregate_state: "pending" });
      await harness.sql`
        UPDATE session_deliveries
        SET state = 'claimed', attempt_token = 'worker-probe'
        WHERE delivery_id = 'delivery-probe'
      `;
    }

    await expect(harness.sql<Array<{ attempt_count: number; count: number }>>`
      SELECT delivery.attempt_count,
        (SELECT COUNT(*)::int FROM session_delivery_attempts AS attempt
          WHERE attempt.delivery_id = delivery.delivery_id
            AND attempt.reason = 'queued_transcript_input_pending') AS count
      FROM session_deliveries AS delivery
      WHERE delivery.delivery_id = 'delivery-probe'
    `).resolves.toMatchObject([
      { attempt_count: DELIVERY_MAX_ATTEMPTS - 1, count: 0 },
    ]);
  });

  it("still ends a transcript probe that has outlived the age budget", async () => {
    await register("delivery-probe-aged", "relation-probe-aged", "durable_next_turn");
    await harness.sql`
      UPDATE session_deliveries
      SET created_at = NOW() - (${DELIVERY_MAX_AGE_MS + 1_000} * INTERVAL '1 millisecond')
      WHERE delivery_id = 'delivery-probe-aged'
    `;
    await repository.claimAttemptForTarget("delivery-probe-aged", "caller-old", "worker-probe");

    await expect(repository.recovery.deferQueuedTranscriptCheck(
      "delivery-probe-aged",
      "worker-probe",
      "queued_transcript_input_pending",
      1_000,
    )).resolves.toMatchObject({
      state: "uncertain",
      aggregate_state: "dead_letter",
    });
  });

  it("dead-letters a delivery older than the retry age budget", async () => {
    await register("delivery-aged", "relation-aged", "durable_next_turn");
    await harness.sql`
      UPDATE session_deliveries
      SET created_at = NOW() - (${DELIVERY_MAX_AGE_MS + 1_000} * INTERVAL '1 millisecond')
      WHERE delivery_id = 'delivery-aged'
    `;
    await repository.claimAttemptForTarget("delivery-aged", "caller-old", "worker-aged");

    await expect(repository.retryDeliveryAttempt(
      "delivery-aged",
      "worker-aged",
      "target busy",
      1_000,
    )).resolves.toMatchObject({
      state: "uncertain",
      aggregate_state: "dead_letter",
    });
  });

  it("schedules the next attempt on the database clock, not the caller's", async () => {
    await register("delivery-clock", "relation-clock", "durable_next_turn");
    await repository.claimAttemptForTarget("delivery-clock", "caller-old", "worker-clock");
    await repository.retryDeliveryAttempt(
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

  function notificationPayload(
    deliveryId: string,
    relationKey: string,
    completionId = "completion-" + relationKey,
  ): Record<string, unknown> {
    return {
      text: "done",
      user: "agent",
      source: "completion_notifier",
      delivery_id: deliveryId,
      delivery_intent: "completion_notification",
      completion_id: completionId,
      relation_key: relationKey,
      disposition: "auto_resume",
      caller_info: null,
    };
  }

});

function silentLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
}

async function waitForApplicationLock(
  sql: SqlClient,
  applicationName: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<Array<{ waiting: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE application_name = ${applicationName}
          AND wait_event_type = 'Lock'
      ) AS waiting
    `;
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${applicationName} to block on a lock`);
}

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}

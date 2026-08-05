import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDeliveryRepository } from "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import type { SqlClient } from "../../src/db/session_db.js";
import { TaskDeliveryLedgerGate } from "../../src/task/task_delivery_ledger_gate.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
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

  async function register(deliveryId: string, relationKey: string): Promise<void> {
    await repository.register({
      deliveryId,
      targetSessionId: "caller-old",
      relationKey,
      completionId: `completion-${relationKey}`,
      intent: "completion_notification",
      source: "completion_notifier",
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

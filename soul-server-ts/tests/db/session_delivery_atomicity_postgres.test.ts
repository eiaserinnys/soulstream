import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDeliveryRepository } from "../../src/db/repositories/session_delivery_repository.js";
import type { SqlClient } from "../../src/db/session_db.js";
import { CompletionDeliveryCoordinator } from "../../src/task/completion_delivery_coordinator.js";
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
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM supervisor_registry`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (session_id, session_type, status, agent_id)
      VALUES
        ('supervisor-old', 'claude', 'completed', 'ariella'),
        ('supervisor-mid', 'claude', 'completed', 'ariella'),
        ('supervisor-new', 'claude', 'completed', 'ariella'),
        ('child-session', 'claude', 'completed', 'worker')
    `;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("serializes consume-first, dispatch-first, and queued-first on the real row", async () => {
    await register("delivery-consume-first", "relation-consume-first");
    await repository.claimForTarget("delivery-consume-first", "supervisor-old");

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
    await repository.claimForTarget("delivery-dispatch-first", "supervisor-old");
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
    await repository.claimForTarget("delivery-queued-first", "supervisor-old");
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

  it("persists before the supervisor exists and recovers exactly once to the current supervisor", async () => {
    let delivered = 0;
    const coordinator = new CompletionDeliveryCoordinator({
      repository,
      dispatch: async (params) => {
        const won = await repository.beginDispatch(
          params.deliveryId!,
          params.deliveryLeaseOwner,
        );
        if (!won) throw new Error("dispatch lease lost");
        delivered += 1;
        await repository.markQueued(
          params.deliveryId!,
          params.deliveryLeaseOwner,
        );
      },
      logger: silentLogger(),
    });

    await coordinator.enqueue(completionInput());
    const pending = await repository.getByRelation("child_session:child-session:42");
    expect(pending).toMatchObject({
      state: "pending",
      target_session_id: null,
    });
    expect(delivered).toBe(0);

    await insertSupervisor("supervisor-new", 5);
    await makeDeliveriesDue();
    await coordinator.recoverPending();
    await coordinator.recoverPending();

    expect(delivered).toBe(1);
    expect(await repository.get(pending!.delivery_id)).toMatchObject({
      state: "queued",
      target_session_id: "supervisor-new",
    });
  });

  it("survives consecutive handovers with one durable effect and no stale claim", async () => {
    await insertSupervisor("supervisor-old", 1);
    const dispatchTargets: string[] = [];
    let delivered = 0;
    const coordinator = new CompletionDeliveryCoordinator({
      repository,
      dispatch: async (params) => {
        dispatchTargets.push(params.agentSessionId);
        if (dispatchTargets.length === 1) {
          await updateSupervisor("supervisor-mid", 2);
        } else if (dispatchTargets.length === 2) {
          await updateSupervisor("supervisor-new", 3);
        }
        const won = await repository.beginDispatch(
          params.deliveryId!,
          params.deliveryLeaseOwner,
        );
        if (!won) throw new Error("supervisor changed before dispatch");
        delivered += 1;
        await repository.markQueued(
          params.deliveryId!,
          params.deliveryLeaseOwner,
        );
      },
      logger: silentLogger(),
    });

    await coordinator.enqueue(completionInput());
    await makeDeliveriesDue();
    await coordinator.recoverPending();
    await makeDeliveriesDue();
    await coordinator.recoverPending();
    await makeDeliveriesDue();
    await coordinator.recoverPending();

    expect(dispatchTargets).toEqual([
      "supervisor-old",
      "supervisor-mid",
      "supervisor-new",
    ]);
    expect(delivered).toBe(1);
    expect(await repository.getByRelation("child_session:child-session:42"))
      .toMatchObject({
        state: "queued",
        target_session_id: "supervisor-new",
      });
  });

  it("suppresses an already-consumed PostgreSQL row before queue, resume, wake, or publish", async () => {
    const gate = new TaskDeliveryLedgerGate(true, repository);
    const params = {
      agentSessionId: "supervisor-old",
      text: "done",
      user: "agent",
      deliveryId: "delivery-consumed-e2e",
      deliveryIntent: "completion_notification" as const,
      source: "completion_notifier",
      completionId: "completion-consumed-e2e",
      relationKey: "relation-consumed-e2e",
    };
    await gate.recordInlineConsumed(params, {
      agentSessionId: "supervisor-old",
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

  async function register(deliveryId: string, relationKey: string): Promise<void> {
    await repository.register({
      deliveryId,
      targetSessionId: "supervisor-old",
      relationKey,
      completionId: `completion-${relationKey}`,
      intent: "completion_notification",
      source: "completion_notifier",
      payloadHash: `hash-${relationKey}`,
      payload: { text: "done" },
    });
  }

  async function insertSupervisor(sessionId: string, epoch: number): Promise<void> {
    await harness.sql`
      INSERT INTO supervisor_registry (
        role, active_session_id, epoch, cursor_offset, handover_state,
        cumulative_tokens, compaction_count
      ) VALUES ('ariella', ${sessionId}, ${epoch}, 0, 'idle', 0, 0)
    `;
  }

  async function updateSupervisor(sessionId: string, epoch: number): Promise<void> {
    await peer`
      UPDATE supervisor_registry
      SET active_session_id = ${sessionId}, epoch = ${epoch}, updated_at = NOW()
      WHERE role = 'ariella'
    `;
  }

  async function makeDeliveriesDue(): Promise<void> {
    await harness.sql`
      UPDATE session_deliveries
      SET next_attempt_at = NOW()
      WHERE state = 'pending'
    `;
  }
});

function completionInput() {
  return {
    targetSessionId: "supervisor-old",
    sourceSessionId: "child-session",
    supervisorRole: "ariella",
    terminalRevision: "42",
    text: "done",
    callerInfo: { source: "agent", agent_id: "ariella" },
    createdAt: new Date("2026-07-26T00:00:00Z"),
  };
}

function silentLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}

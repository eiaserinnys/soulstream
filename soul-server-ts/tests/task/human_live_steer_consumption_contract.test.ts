import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type {
  EnginePort,
  SSEEventPayload,
} from "../../src/engine/protocol.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { buildCanonicalDeliveryPayload } from "../../src/task/delivery_payload.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

const agent: AgentProfile = {
  id: "claude-roselin",
  name: "로젤린",
  backend: "claude",
  workspace_dir: "/tmp/claude-roselin",
};

type DeliveryState = "queued" | "delivered" | "consumed";

interface DeliveryEvidenceRow {
  deliveryId: string;
  payloadHash: string;
  payload: Record<string, unknown>;
  state: DeliveryState;
  targetReceiptId: string | null;
  consumedAt: string | null;
}

/**
 * C production oracle: the ledger state and the event named by its receipt are
 * one indivisible claim. A consumed row without a matching input event is not
 * delivery evidence.
 */
class HumanLiveSteerEvidenceLedger {
  readonly row: DeliveryEvidenceRow;

  readonly recordTurnStarted = vi.fn(async (_message: InterventionMessage, task: Task) => {
    const receiptId = `event:${task.lastEventId ?? "unknown"}`;
    this.row.state = "delivered";
    this.row.targetReceiptId = receiptId;
  });

  readonly recordConsumed = vi.fn(async () => {
    if (process.env.SOULSTREAM_C_ORACLE_MUTATION === "drop_consumed_write") return;
    this.row.state = "consumed";
    this.row.consumedAt = "2026-08-24T15:53:26.597Z";
  });

  constructor(
    deliveryId: string,
    payloadHash: string,
    payload: Record<string, unknown>,
    private readonly getPersistedEvent: (receiptId: string) => SSEEventPayload | undefined,
  ) {
    this.row = {
      deliveryId,
      payloadHash,
      payload,
      state: "queued",
      targetReceiptId: null,
      consumedAt: null,
    };
  }

  assertConsumptionContract(): void {
    if (this.row.state !== "consumed") {
      expect(["queued", "delivered"]).toContain(this.row.state);
      expect(this.row.consumedAt).toBeNull();
      return;
    }

    expect(this.row.consumedAt).not.toBeNull();
    expect(this.row.targetReceiptId).not.toBeNull();
    if (process.env.SOULSTREAM_C_ORACLE_MUTATION === "hide_model_input_proof") {
      return;
    }
    const receiptEvent = this.getPersistedEvent(this.row.targetReceiptId!);
    expect(receiptEvent).toMatchObject({
      type: "intervention_sent",
      text: this.row.payload.text,
      user: this.row.payload.user,
    });
  }
}

interface HarnessOptions {
  deliveryId: string;
  failure?: Error;
  precedingEvent: {
    eventId: number;
    event: SSEEventPayload;
  };
}

async function executeHumanLiveSteer(options: HarnessOptions): Promise<HumanLiveSteerEvidenceLedger> {
  const text = `human-live-steer:${options.deliveryId}`;
  const completionId = `message:${options.deliveryId}`;
  const relationKey = `user_message:8ad6935c:${options.deliveryId}`;
  const canonical = buildCanonicalDeliveryPayload({
    text,
    user: "agent",
    source: "user_message",
    completionId,
    relationKey,
  });
  const persistenceDouble = makeEventPersistenceTestDouble(
    undefined,
    [options.precedingEvent],
  );
  const ledger = new HumanLiveSteerEvidenceLedger(
    options.deliveryId,
    canonical.payloadHash,
    canonical.payload,
    (receiptId) => {
      const match = /^event:(\d+)$/.exec(receiptId);
      return match ? persistenceDouble.getEventById(Number(match[1])) : undefined;
    },
  );
  const db = {
    updateSession: vi.fn().mockResolvedValue(undefined),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
    emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;
  const engine = makeEngine(options.failure);
  const executor = new TaskExecutor(
    () => engine,
    db,
    persistenceDouble.persistence,
    broadcaster,
    silentLogger,
    undefined,
    undefined,
    undefined,
    undefined,
    ledger,
  );
  const intervention: InterventionMessage = {
    text,
    user: "agent",
    source: "user_message",
    deliveryId: options.deliveryId,
    deliveryIntent: "human_live_steer",
    completionId,
    relationKey,
    storedDeliveryPayload: canonical.payload,
    storedDeliveryPayloadHash: canonical.payloadHash,
  };
  const task: Task = {
    agentSessionId: "8ad6935c-ac67-42d9-8af8-44323dbf9c40",
    prompt: "existing foreground turn",
    status: "running",
    profileId: agent.id,
    createdAt: new Date("2026-08-24T15:49:08.000Z"),
    lastEventId: options.precedingEvent.eventId,
    lastReadEventId: options.precedingEvent.eventId - 1,
    interventionQueue: [intervention],
  };

  executor.startExecution(task, agent);
  await task.executionPromise;
  return ledger;
}

function makeEngine(failure?: Error): EnginePort {
  return {
    backendId: "claude",
    workspaceDir: "/tmp/claude-roselin",
    async *execute(): AsyncIterable<SSEEventPayload> {
      if (failure) throw failure;
      yield {
        type: "assistant_message",
        content: "human live steer consumed",
        timestamp: 1,
      };
    },
    async interrupt() {
      return true;
    },
    async close() {},
  };
}

describe("human_live_steer consumption evidence", () => {
  it("keeps an execute timeout replayable when its receipt points at context_usage", async () => {
    const ledger = await executeHumanLiveSteer({
      deliveryId: "25b5ba7f-6c2b-471c-a6b0-12e7c367b348",
      failure: new Error("Runner IPC request timed out after 30000ms"),
      precedingEvent: {
        eventId: 2595,
        event: {
          type: "context_usage",
          used_tokens: 781_290,
          max_tokens: 1_000_000,
          percent: 78.129,
        } as SSEEventPayload,
      },
    });

    ledger.assertConsumptionContract();
  });

  it("keeps a rejected runner claim replayable when its receipt is ownership metadata", async () => {
    const deliveryId = "d4860070-9621-4736-a2aa-72bea89f764d";
    const ledger = await executeHumanLiveSteer({
      deliveryId,
      failure: new Error(
        `Runner command execute:ebd7208d failed (execute_intervention_claim_failed): `
          + `runner intervention unavailable: ${deliveryId}`,
      ),
      precedingEvent: {
        eventId: 2655,
        event: {
          type: "metadata",
          metadata_type: "execution_ownership_transition",
          value: { phase: "execution_activate" },
        } as unknown as SSEEventPayload,
      },
    });

    ledger.assertConsumptionContract();
  });

  it("keeps a proven model input consumed", async () => {
    const deliveryId = "healthy-live-steer-delivery";
    const ledger = await executeHumanLiveSteer({
      deliveryId,
      precedingEvent: {
        eventId: 7001,
        event: {
          type: "intervention_sent",
          text: `human-live-steer:${deliveryId}`,
          user: "agent",
          timestamp: 1,
        } as SSEEventPayload,
      },
    });

    expect(ledger.row.state).toBe("consumed");
    ledger.assertConsumptionContract();
  });
});

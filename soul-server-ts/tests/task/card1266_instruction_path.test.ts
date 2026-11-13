import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import type { EnginePort } from "../../src/engine/protocol.js";
import { createTaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { RunnerProcessDispatcher } from "../../src/runner/runner_process_dispatcher.js";
import { composeQueuedDeliveryStartupRecovery } from
  "../../src/runtime/claude_runtime_composition.js";
import { createInstructionReceiptLookup } from "../../src/task/delivery_instruction_receipt.js";
import { QueuedDeliveryTranscriptRecovery } from
  "../../src/task/queued_delivery_transcript_recovery.js";
import type { NodeInstructionVerdict } from
  "../../src/task/state/node_instruction_decision.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import { TaskTurnInputBuilder } from "../../src/task/task_turn_input_builder.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

/** A runner whose intervene call dies after the runner may have received it. */
function makeTimedOutTask(lookup?: unknown, registrationId: string | null = "reg-1") {
  const intervene = vi.fn().mockRejectedValue(new Error("runner response timed out"));
  const dispatcher = {
    ...(registrationId ? { registrationId: () => registrationId } : {}),
    ...(lookup ? { lookupInterventionReceipt: lookup } : {}),
  };
  const task = {
    agentSessionId: "session-card1266",
    prompt: "original prompt",
    status: "running",
    profileId: "codex-default",
    createdAt: new Date("2026-11-13T00:00:00.000Z"),
    lastEventId: 1,
    lastReadEventId: 0,
    interventionQueue: [],
    runner: createTaskRunnerRuntime(
      {
        backendId: "codex",
        workspaceDir: "/tmp/card1266",
        async *execute() {},
        async interrupt() { return true; },
        async close() {},
        intervene,
      } as unknown as EnginePort,
      dispatcher as never,
      "runner",
    ),
  } as Task;
  return { task, intervene };
}

function makeTransition(): RunningInterventionTransition {
  return new RunningInterventionTransition({
    broadcaster: { emitEventEnvelope: vi.fn().mockResolvedValue(undefined) } as unknown as
      SessionBroadcaster,
    logger: silentLogger,
    persistence: makeEventPersistenceTestDouble().persistence,
  });
}

const ledgerMessage: InterventionMessage = {
  text: "steer once",
  user: "alice",
  deliveryId: "delivery-card1266",
};

describe("card1266 instruction path: ask the runner by number", () => {
  it("does not queue an instruction the runner reports as applied (no double injection)", async () => {
    const lookup = vi.fn().mockResolvedValue("applied");
    const { task, intervene } = makeTimedOutTask(lookup);
    const register = vi.fn().mockResolvedValue(undefined);
    task.activeDeliveryTurnReceipt = { register } as never;

    await expect(makeTransition().deliver(task, ledgerMessage)).resolves.toEqual({
      delivered: true,
    });

    expect(lookup).toHaveBeenCalledWith("delivery-card1266", "reg-1");
    expect(intervene).toHaveBeenCalledOnce();
    expect(task.interventionQueue).toEqual([]);
    expect(register).toHaveBeenCalledWith(ledgerMessage);
  });

  it("resends (queues) only when the same registration says it never received the number", async () => {
    const lookup = vi.fn().mockResolvedValue("not_applied");
    const { task } = makeTimedOutTask(lookup);

    await expect(makeTransition().deliver(task, ledgerMessage)).resolves.toMatchObject({
      delivered: false,
      queued: true,
    });
    expect(task.interventionQueue).toEqual([ledgerMessage]);
  });

  it.each([
    ["the runner says unknown", vi.fn().mockResolvedValue("unknown"), "reg-1"],
    ["the lookup throws", vi.fn().mockRejectedValue(new Error("socket closed")), "reg-1"],
    ["the dispatcher cannot look receipts up", undefined, "reg-1"],
    ["no registration is known", vi.fn().mockResolvedValue("not_applied"), null],
  ])("treats the result as unknown and never queues or resends when %s", async (
    _label,
    lookup,
    registrationId,
  ) => {
    const { task, intervene } = makeTimedOutTask(lookup, registrationId);

    await expect(makeTransition().deliver(task, ledgerMessage)).resolves.toEqual({
      delivered: null,
      reason: "verdict_unknown",
      consumeWhen: null,
    });
    expect(task.interventionQueue).toEqual([]);
    expect(intervene).toHaveBeenCalledOnce();
  });

  it("treats an old runner that does not know the lookup command as unknown (C7)", async () => {
    const oldRunnerInvoke = vi.fn().mockResolvedValue({ status: "not_supported" });
    const lookup = (id: string, registration: string) =>
      RunnerProcessDispatcher.prototype.lookupInterventionReceipt.call(
        { invoke: oldRunnerInvoke } as never,
        id,
        registration,
      );
    const { task, intervene } = makeTimedOutTask(lookup);

    await expect(makeTransition().deliver(task, ledgerMessage)).resolves.toEqual({
      delivered: null,
      reason: "verdict_unknown",
      consumeWhen: null,
    });
    expect(oldRunnerInvoke).toHaveBeenCalledWith(
      "runner.intervention_receipt",
      ["delivery-card1266"],
    );
    expect(task.interventionQueue).toEqual([]);
    expect(intervene).toHaveBeenCalledOnce();
  });
});

describe("card1266 instruction path: one number for every handoff", () => {
  it("fixes a number before the handoff and keeps it on the queued copy", async () => {
    const intervene = vi.fn().mockResolvedValue({
      status: "not_delivered",
      mechanism: "active_turn",
      reason: "no_active_turn",
    });
    const { task } = makeTimedOutTask();
    (task.runner!.engine as unknown as { intervene: unknown }).intervene = intervene;
    const message: InterventionMessage = { text: "legacy", user: "alice" };

    await makeTransition().deliver(task, message);

    const sent = intervene.mock.calls[0]![0] as { runnerInterventionId: string };
    expect(sent.runnerInterventionId.length).toBeGreaterThan(0);
    expect(task.interventionQueue[0]?.runnerInterventionId).toBe(sent.runnerInterventionId);
    expect(message).toEqual({ text: "legacy", user: "alice" });
  });

  it("makes the next execution carry the same number, from a ledger id or a stored number", async () => {
    const builder = new TaskTurnInputBuilder({
      contextBuilder: {
        buildFollowupContext: vi.fn().mockResolvedValue({ contextItems: [] }),
      } as never,
      initialMessagePublisher: {} as never,
      logger: { warn: vi.fn() } as never,
    });
    const agent: AgentProfile = {
      id: "codex-default",
      name: "Codex",
      backend: "codex",
      workspace_dir: "/tmp/card1266",
    };
    const task = {
      agentSessionId: "session-card1266",
      prompt: "p",
      status: "running",
      createdAt: new Date("2026-11-13T00:00:00.000Z"),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    } as Task;

    const byLedger = await builder.prepareFollowupTurnInput(task, agent, [
      { text: "a", user: "u", deliveryId: "delivery-queued" },
    ]);
    expect(byLedger.runnerInterventionId).toBe("delivery-queued");
    expect(byLedger.runnerInterventionIds).toEqual(["delivery-queued"]);

    const byStored = await builder.prepareFollowupTurnInput(task, agent, [
      { text: "a", user: "u", runnerInterventionId: "number-stored" },
      { text: "b", user: "u", deliveryId: "delivery-2" },
    ]);
    expect(byStored.runnerInterventionId).toBe("number-stored");
    expect(byStored.runnerInterventionIds).toEqual(["number-stored", "delivery-2"]);
  });
});

function row(id: string, state = "claimed", target = "session-codex"): SessionDeliveryRow {
  return {
    delivery_id: id,
    target_session_id: target,
    intent: "human_live_steer",
    source: "user_message",
    state,
    aggregate_state: state === "uncertain" ? "dead_letter" : "pending",
    attempt_token: "worker-card1266",
    payload: { text: "x", user: "alice" },
  } as unknown as SessionDeliveryRow;
}

describe("card1266 instruction path: restart recovery of a Codex queue (I6)", () => {
  it("re-enters what was never sent, closes what was applied, and leaves the unknown uncertain", async () => {
    const verdicts: Record<string, NodeInstructionVerdict> = {
      unsent: "not_applied",
      applied: "applied",
      handed: "unknown",
    };
    const rows = new Map(["unsent", "applied", "handed"].map((id) => [id, row(id)]));
    const markConsumed = vi.fn(async (id: string) => ({
      ...rows.get(id)!,
      state: "consumed",
      aggregate_state: "consumed",
    }) as SessionDeliveryRow);
    const markUncertain = vi.fn(async (id: string) => ({
      ...rows.get(id)!,
      state: "uncertain",
      aggregate_state: "dead_letter",
    }) as SessionDeliveryRow);
    const retryDeliveryAttempt = vi.fn(async (id: string) => ({
      ...rows.get(id)!,
      state: "pending",
    }) as SessionDeliveryRow);
    const redeliverContent = vi.fn(async () => undefined);
    let claimable = [...rows.values()];
    const recovery = new QueuedDeliveryTranscriptRecovery({
      deliveryRepository: {
        get: vi.fn(async (id: string) => rows.get(id) ?? null),
        markConsumed,
        markUncertain,
        retryDeliveryAttempt,
      },
      recoveryRepository: {
        claimQueuedAfterNodeRestart: vi.fn(async () => {
          const claimed = claimable;
          claimable = [];
          return claimed;
        }),
        markDeliveredFromTranscript: vi.fn(),
      },
      transcriptReceipt: {
        inspect: vi.fn(async (r: SessionDeliveryRow) => ({
          kind: "unavailable" as const,
          inputUuid: `delivery:${r.delivery_id}`,
          reason: "unsupported_backend",
        })),
      },
      instructionReceipt: { lookup: async (r) => verdicts[r.delivery_id]! },
      redeliverContent,
      logger: { warn: vi.fn() },
    } as never, "worker-card1266");

    await expect(recovery.recoverAfterNodeRestart("node-a")).resolves.toEqual({
      claimed: 3,
      settled: 3,
    });

    expect(redeliverContent).toHaveBeenCalledOnce();
    expect(redeliverContent).toHaveBeenCalledWith(expect.objectContaining({ delivery_id: "unsent" }));
    expect(markConsumed).toHaveBeenCalledWith("applied", "runner_receipt:applied");
    expect(markUncertain).toHaveBeenCalledOnce();
    expect(markUncertain).toHaveBeenCalledWith(
      "handed",
      "worker-card1266",
      "runner_receipt_unknown",
    );
    // Nothing is parked in pending for good ("unsupported_backend").
    expect(retryDeliveryAttempt).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "unsupported_backend",
      expect.anything(),
    );
  });

  it("asks the runner of the task the node holds, and says unknown for a session it holds none for", async () => {
    const lookupReceipt = vi.fn().mockResolvedValue("not_applied");
    const task = {
      agentSessionId: "session-codex",
      runner: {
        dispatcher: { registrationId: () => "reg-9", lookupInterventionReceipt: lookupReceipt },
      },
    } as unknown as Task;
    const lookup = createInstructionReceiptLookup(
      (id) => (id === "session-codex" ? task : undefined),
    );

    await expect(lookup(row("d-1"))).resolves.toBe("not_applied");
    expect(lookupReceipt).toHaveBeenCalledWith("d-1", "reg-9");
    await expect(lookup(row("d-2", "claimed", "session-gone"))).resolves.toBe("unknown");
  });

  it("assembles the startup recovery without the Claude session runtime flag", async () => {
    const claimQueuedAfterNodeRestart = vi.fn(async () => []);
    const startup = composeQueuedDeliveryStartupRecovery({
      db: {
        sessionDeliveries: () => ({
          recovery: { claimQueuedAfterNodeRestart, markDeliveredFromTranscript: vi.fn() },
          get: vi.fn(),
          markConsumed: vi.fn(),
          markUncertain: vi.fn(),
          retryDeliveryAttempt: vi.fn(),
        }),
        getSession: vi.fn(),
      } as never,
      agentRegistry: { get: vi.fn() } as never,
      modelCatalog: { resolve: vi.fn() },
      sessionStore: {} as never,
      sourceNode: "node-codex",
      logger: silentLogger,
      redeliverContent: vi.fn(),
      lookupInstructionReceipt: async () => "unknown",
    });

    await startup.afterRunnerRecovery();

    expect(claimQueuedAfterNodeRestart).toHaveBeenCalledWith(
      "node-codex",
      expect.any(String),
      expect.any(Number),
      expect.any(Number),
      false,
    );
  });
});

describe("card1266 instruction path: a finished session's queued delivery is not accepted again on every start (case 17)", () => {
  function makeLedger(lookupVerdict: NodeInstructionVerdict) {
    const ledger = new Map<string, SessionDeliveryRow>([
      ["stuck", row("stuck", "queued", "session-finished")],
    ]);
    const redeliverContent = vi.fn(async (r: SessionDeliveryRow) => {
      // The route accepts it durably, but the finished target never consumes it.
      ledger.set(r.delivery_id, { ...r, state: "queued" } as SessionDeliveryRow);
    });
    const start = async () => {
      const recovery = new QueuedDeliveryTranscriptRecovery({
        deliveryRepository: {
          get: vi.fn(async (id: string) => ledger.get(id) ?? null),
          markConsumed: vi.fn(),
          markUncertain: vi.fn(async (id: string) => {
            const next = {
              ...ledger.get(id)!,
              state: "uncertain",
              aggregate_state: "dead_letter",
            } as SessionDeliveryRow;
            ledger.set(id, next);
            return next;
          }),
          retryDeliveryAttempt: vi.fn(async (id: string) => {
            const next = { ...ledger.get(id)!, state: "pending" } as SessionDeliveryRow;
            ledger.set(id, next);
            return next;
          }),
        },
        recoveryRepository: {
          claimQueuedAfterNodeRestart: vi.fn(async () =>
            [...ledger.values()].filter((r) => r.state === "queued")),
          markDeliveredFromTranscript: vi.fn(),
        },
        transcriptReceipt: {
          inspect: vi.fn(async (r: SessionDeliveryRow) => ({
            kind: "absent" as const,
            inputUuid: `delivery:${r.delivery_id}`,
          })),
        },
        instructionReceipt: { lookup: async () => lookupVerdict },
        redeliverContent,
        logger: { warn: vi.fn() },
      } as never, "worker-card1266");
      return await recovery.recoverAfterNodeRestart("node-a");
    };
    return { ledger, redeliverContent, start };
  }

  it("leaves it uncertain on the first start and does not pick it up on the second", async () => {
    const { ledger, redeliverContent, start } = makeLedger("unknown");

    await expect(start()).resolves.toEqual({ claimed: 1, settled: 1 });
    await expect(start()).resolves.toEqual({ claimed: 0, settled: 0 });

    expect(redeliverContent).not.toHaveBeenCalled();
    expect(ledger.get("stuck")?.state).toBe("uncertain");
  });
});

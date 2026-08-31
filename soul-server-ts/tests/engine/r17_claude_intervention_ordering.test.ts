import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  ClaudeEngineAdapter,
  ClaudeSdkClient,
} from "../../src/engine/claude_adapter.js";
import { ClaudeSessionClientRegistry } from
  "../../src/engine/claude_session_client_registry.js";
import {
  abortSignal,
  collect,
  collectSse,
  makeHarness,
  runOptions,
  sdkInit,
  sdkInterruptedResult,
  sdkResult,
  sdkToolStart,
} from "./claude_sdk_persistent_test_harness.js";

const silentLogger = pino({ level: "silent" });
const interruptArrivalOrders = [
  ["receipt", "result", "continuation"],
  ["receipt", "continuation", "result"],
  ["result", "receipt", "continuation"],
  ["result", "continuation", "receipt"],
  ["continuation", "receipt", "result"],
  ["continuation", "result", "receipt"],
] as const;

describe("R17 Claude intervention arrival ordering", () => {
  it("acknowledges an observed Result while the receipt remains pending", async () => {
    const harness = makeHarness();
    let releaseReceipt!: () => void;
    const receipt = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    harness.interrupt.mockImplementationOnce(async () => await receipt);
    const registry = new ClaudeSessionClientRegistry(
      () => new ClaudeSdkClient(
        { query: harness.queryFn, detachedEventSink: harness.detached },
        silentLogger,
      ),
      { idleTtlMs: 300_000, maxEntries: 4 },
    );
    const engine = new ClaudeEngineAdapter(
      {
        workspaceDir: "/tmp/r17-claude-intervention",
        persistentSessionRegistry: registry,
        processEnv: {},
      },
      silentLogger,
    );

    try {
      const oldTurn = collectSse(engine.execute({
        agentSessionId: "agent-session",
        prompt: "perform a multi-tool task",
      }));
      const oldInput = await harness.nextInput();
      harness.push(oldInput as SDKMessage);
      harness.push(sdkInit("sdk-session"));

      let interventionSettled = false;
      const intervention = engine.intervene({ prompt: "stop now" }).then((result) => {
        interventionSettled = true;
        return result;
      });
      await vi.waitFor(() => expect(harness.interrupt).toHaveBeenCalledTimes(1));
      harness.push(sdkInterruptedResult("sdk-session", oldInput.uuid));
      await expect(oldTurn).resolves.toEqual(expect.any(Array));
      await vi.waitFor(
        () => expect(interventionSettled).toBe(true),
        { timeout: 200 },
      );
      await expect(intervention).resolves.toEqual({
        status: "not_delivered",
        mechanism: "interrupt_then_next_turn",
        reason: "next_turn_required",
      });
      expect(harness.close).not.toHaveBeenCalled();

      const nextTurn = collectSse(engine.execute({
        agentSessionId: "agent-session",
        prompt: "answer the intervention",
      }));
      const nextInput = await harness.nextInput();
      harness.push(nextInput as SDKMessage);
      harness.push(sdkResult(
        "sdk-session",
        nextInput.uuid,
        "intervention handled",
      ));
      await expect(nextTurn).resolves.toContainEqual(
        expect.objectContaining({ type: "complete", result: "intervention handled" }),
      );
      expect(harness.captured).toHaveLength(1);
    } finally {
      releaseReceipt();
      await registry.shutdown();
    }
  });

  it.each(interruptArrivalOrders)(
    "is timing-independent for %s -> %s -> %s",
    async (...arrivalOrder) => {
      const harness = makeHarness();
      let releaseReceipt!: () => void;
      let markReceiptReturned!: () => void;
      const receiptGate = new Promise<void>((resolve) => {
        releaseReceipt = resolve;
      });
      const receiptReturned = new Promise<void>((resolve) => {
        markReceiptReturned = resolve;
      });
      harness.interrupt.mockImplementationOnce(async () => {
        await receiptGate;
        markReceiptReturned();
      });
      const registry = new ClaudeSessionClientRegistry(
        () => new ClaudeSdkClient(
          { query: harness.queryFn, detachedEventSink: harness.detached },
          silentLogger,
        ),
        { idleTtlMs: 300_000, maxEntries: 4 },
      );
      const engine = new ClaudeEngineAdapter(
        {
          workspaceDir: "/tmp/r17-claude-intervention",
          persistentSessionRegistry: registry,
          processEnv: {},
        },
        silentLogger,
      );
      let oldTurnSettled = false;

      try {
        const oldTurn = collectSse(engine.execute({
          agentSessionId: "agent-session",
          prompt: "perform a multi-tool task",
        })).then((events) => {
          oldTurnSettled = true;
          return events;
        });
        const oldInput = await harness.nextInput();
        harness.push(oldInput as SDKMessage);
        harness.push(sdkInit("sdk-session"));
        let interventionSettled = false;
        let interventionFailure: unknown;
        const intervention = engine.intervene({ prompt: "stop now" });
        void intervention.then(
          () => {
            interventionSettled = true;
          },
          (error: unknown) => {
            interventionFailure = error;
            interventionSettled = true;
          },
        );
        await vi.waitFor(() => expect(harness.interrupt).toHaveBeenCalledTimes(1));

        let resultObserved = false;
        for (const arrival of arrivalOrder) {
          if (arrival === "receipt") {
            releaseReceipt();
            await receiptReturned;
          } else if (arrival === "result") {
            harness.push(sdkInterruptedResult("sdk-session", oldInput.uuid));
            await vi.waitFor(() => expect(oldTurnSettled).toBe(true));
            resultObserved = true;
          } else {
            harness.push(sdkToolStart(
              "tool-after-intervention",
              "tool-must-not-start",
            ));
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (arrival === "result") {
            await vi.waitFor(
              () => expect(interventionSettled).toBe(true),
              { timeout: 200 },
            );
            expect(interventionFailure).toBeUndefined();
          } else if (!resultObserved) {
            expect(interventionSettled).toBe(false);
          }
        }

        await expect(intervention).resolves.toEqual(expect.objectContaining({
          reason: "next_turn_required",
        }));
        const oldEvents = await oldTurn;
        expect(oldEvents.filter((event) => event.type === "error")).toEqual([]);
        expect(oldEvents).not.toContainEqual(expect.objectContaining({
          type: "tool_start",
          tool_use_id: "tool-must-not-start",
        }));

        const nextTurn = collectSse(engine.execute({
          agentSessionId: "agent-session",
          prompt: "answer the intervention",
        }));
        const nextInput = await harness.nextInput();
        harness.push(nextInput as SDKMessage);
        harness.push(sdkResult("sdk-session", nextInput.uuid, "intervention handled"));
        const nextEvents = await nextTurn;
        expect(nextEvents).toContainEqual(expect.objectContaining({
          type: "complete",
          result: "intervention handled",
        }));
        expect(nextEvents.filter((event) => event.type === "error")).toEqual([]);
        expect(harness.captured).toHaveLength(1);
      } finally {
        releaseReceipt();
        await registry.shutdown();
      }
    },
  );

  it("keeps observed success when the native interrupt fails late", async () => {
    const harness = makeHarness();
    let rejectInterrupt!: (error: Error) => void;
    harness.interrupt.mockImplementationOnce(async () => await new Promise(
      (_resolve, reject) => {
        rejectInterrupt = reject;
      },
    ));
    const logger = pino({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const client = new ClaudeSdkClient(
      { query: harness.queryFn, detachedEventSink: harness.detached },
      logger,
    );
    let interruption: Promise<boolean> | undefined;
    let interruptRejected = false;
    try {
      const turn = collect(client.runPersistent(runOptions("long work"), abortSignal()));
      const input = await harness.nextInput();
      let interruptionSettled = false;
      interruption = client.interruptActiveTurnForSteer().then((result) => {
        interruptionSettled = true;
        return result;
      });
      await vi.waitFor(() => expect(harness.interrupt).toHaveBeenCalledTimes(1));
      harness.push(sdkInterruptedResult("sdk-session", input.uuid));
      await turn;
      await vi.waitFor(
        () => expect(interruptionSettled).toBe(true),
        { timeout: 200 },
      );
      await expect(interruption).resolves.toBe(true);

      rejectInterrupt(new Error("late interrupt failure"));
      interruptRejected = true;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining("after its effect was observed"),
      );
      expect(harness.close).not.toHaveBeenCalled();
    } finally {
      if (!interruptRejected) rejectInterrupt(new Error("test cleanup"));
      await interruption?.catch(() => undefined);
      await client.close();
    }
  });
});

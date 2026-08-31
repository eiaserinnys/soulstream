import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  ClaudeEngineAdapter,
  ClaudeSdkClient,
} from "../../src/engine/claude_adapter.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";
import { ClaudeSessionClientRegistry } from
  "../../src/engine/claude_session_client_registry.js";
import {
  collectSse,
  makeHarness,
  sdkInit,
  sdkInterruptedResult,
  sdkResult,
} from "./claude_sdk_persistent_test_harness.js";

const silentLogger = pino({ level: "silent" });

describe("R17 Claude intervention interrupt contract", () => {
  it.each([
    { state: "between tool executions", inFlightTool: false },
    { state: "during an in-flight tool", inFlightTool: true },
  ])(
    "settles the old turn before acknowledging intervention $state",
    async ({ inFlightTool }) => {
      const harness = makeHarness();
      const runtimeEvents: ClaudeClientEvent[] = [];
      let releaseDelayedSink!: () => void;
      const delayedSink = new Promise<void>((resolve) => {
        releaseDelayedSink = resolve;
      });
      const registry = new ClaudeSessionClientRegistry(
        () => new ClaudeSdkClient(
          {
            query: harness.queryFn,
            detachedEventSink: harness.detached,
            runtimeEventSink: async (event) => {
              runtimeEvents.push(event);
              if (
                event.type === "tool_start"
                && event.toolUseId === "tool-must-not-start"
              ) {
                await delayedSink;
              }
              return true;
            },
          },
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
        if (inFlightTool) {
          harness.push(sdkToolStart("tool-before-intervention", "tool-in-flight"));
          await new Promise<void>((resolve) => setImmediate(resolve));
        }

        const intervention = engine.intervene({ prompt: "stop and answer this now" });
        await vi.waitFor(() => expect(harness.interrupt).toHaveBeenCalledTimes(1));
        if (inFlightTool) {
          harness.push(sdkInterruptedResult("sdk-session", oldInput.uuid));
        } else {
          harness.push(sdkToolStart("tool-after-intervention", "tool-must-not-start"));
          await vi.waitFor(
            () => expect(harness.close).toHaveBeenCalledTimes(1),
            { timeout: 200 },
          );
        }
        await expect(intervention).resolves.toEqual({
          status: "not_delivered",
          mechanism: "interrupt_then_next_turn",
          reason: "next_turn_required",
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        const settledWhenAcknowledged = oldTurnSettled;
        if (!inFlightTool) {
          harness.push(sdkResult("sdk-session", oldInput.uuid, "old turn ended naturally"));
        }
        const oldEvents = await oldTurn;

        const nextTurn = collectSse(engine.execute({
          agentSessionId: "agent-session",
          prompt: "stop and answer this now",
        }));
        const nextInput = await harness.nextInput();
        harness.push(nextInput as SDKMessage);
        if (!inFlightTool) harness.push(sdkInit("sdk-session"));
        harness.push(sdkResult("sdk-session", nextInput.uuid, "intervention handled"));
        await expect(nextTurn).resolves.toContainEqual(
          expect.objectContaining({ type: "complete", result: "intervention handled" }),
        );

        expect(settledWhenAcknowledged).toBe(true);
        expect(oldEvents).not.toContainEqual(
          expect.objectContaining({ type: "tool_start", tool_use_id: "tool-must-not-start" }),
        );
        expect(runtimeEvents).not.toContainEqual(
          expect.objectContaining({ type: "tool_start", toolUseId: "tool-must-not-start" }),
        );
        if (inFlightTool) {
          expect(oldEvents).toContainEqual(
            expect.objectContaining({ type: "tool_start", tool_use_id: "tool-in-flight" }),
          );
        }
        expect(harness.captured).toHaveLength(inFlightTool ? 1 : 2);
      } finally {
        releaseDelayedSink();
        await registry.shutdown();
      }
    },
  );

  it("terminalizes the Query when the native interrupt request fails", async () => {
    const harness = makeHarness();
    harness.interrupt.mockRejectedValueOnce(new Error("interrupt control failed"));
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

      await expect(engine.intervene({ prompt: "stop now" })).rejects.toThrow(
        "interrupt control failed",
      );
      await vi.waitFor(() => expect(harness.close).toHaveBeenCalledTimes(1));
      await expect(oldTurn).resolves.toEqual(expect.any(Array));
      expect(oldTurnSettled).toBe(true);
    } finally {
      await registry.shutdown();
    }
  });
});

function sdkToolStart(uuid: string, toolUseId: string): SDKMessage {
  return {
    type: "assistant",
    uuid,
    session_id: "sdk-session",
    message: {
      id: uuid,
      model: "claude",
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: {} }],
    },
  } as unknown as SDKMessage;
}

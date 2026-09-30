import type { SDKControlInterruptResponse, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { ClaudeSdkClient } from "../../src/engine/claude_adapter.js";
import {
  abortSignal, collect, makeHarness, runOptions, sdkInit, sdkInterruptedResult, sdkResult,
} from "./claude_sdk_persistent_test_harness.js";

const silentLogger = pino({ level: "silent" });

describe("browser intervention during persistent CLI boot", () => {
  // Reuse the persistent SDK harness. Both control/data ordering cases must let
  // the human input run; no assertion requires a stalled or detached Result.
  // The queued UUID is admitted through runPersistent before init/assistant
  // output. SDKControlInterruptResponse permits still_queued for that UUID.
  it.each(["receipt-first", "result-first"] as const)(
    "finishes the interrupted boot turn and runs the human input (%s)",
    async (order) => {
      const inputUuid = "40c11b0e-72c9-5113-91fa-01949e0ae1ea";
      const harness = makeHarness();
      let releaseReceipt!: (receipt: SDKControlInterruptResponse) => void;
      harness.interrupt.mockImplementation(() => new Promise((resolve) => {
        releaseReceipt = resolve;
      }));
      const client = new ClaudeSdkClient({
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        postResultDrainMs: 5,
      }, silentLogger);
      let turnFinished = false;
      const turn = collect(client.runPersistent({
        ...runOptions("delegated work completed"),
        inputUuid,
        turnOrigin: { kind: "completion_notification", id: "boot-completion" },
      }, abortSignal())).then((events) => {
        turnFinished = true;
        return events;
      });
      let interruptObserved = false;
      let interruption: Promise<boolean> | undefined;
      try {
        // A browser input arrives before the CLI has emitted init or assistant
        // output. It is held for the next run until this interrupt takes effect.
        interruption = client.interruptActiveTurnForSteer().then((observed) => {
          interruptObserved = observed;
          return observed;
        });
        await vi.waitFor(() => expect(harness.interrupt).toHaveBeenCalledOnce());
        if (order === "receipt-first") {
          releaseReceipt({ still_queued: [inputUuid] });
          // Let the control receipt propagate before CLI boot resumes.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        harness.push(sdkInit("sdk-session"));
        expect((await harness.nextInput()).uuid).toBe(inputUuid);
        harness.push({
          ...sdkInterruptedResult("sdk-session", inputUuid),
          errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
          terminal_reason: "aborted_streaming",
        } as unknown as SDKMessage);
        if (order === "result-first") {
          await vi.waitFor(() => expect(interruptObserved).toBe(true), { timeout: 250 });
          releaseReceipt({ still_queued: [inputUuid] });
        }
        await vi.waitFor(() => {
          expect(interruptObserved).toBe(true);
          expect(turnFinished).toBe(true);
        }, { timeout: 250 });
        await expect(interruption).resolves.toBe(true);
        await turn;

        const humanTurn = collect(client.runPersistent({
          ...runOptions("human browser message"),
          turnOrigin: { kind: "user_message", id: "browser-input" },
        }, abortSignal()));
        const humanInput = await harness.nextInput();
        harness.push(sdkResult("sdk-session", humanInput.uuid, "human message answered"));
        await expect(humanTurn).resolves.toContainEqual(
          expect.objectContaining({ type: "complete", result: "human message answered" }),
        );
      } finally {
        // Close only the isolated fake Query; never touch the live stalled runner.
        await client.close("shutdown");
        await turn;
        await interruption;
      }
    },
  );
});

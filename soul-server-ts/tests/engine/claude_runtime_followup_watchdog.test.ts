import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeRuntimeFollowupWatchdog } from
  "../../src/engine/claude_runtime_followup_watchdog.js";
import { isTurnStartingUserInput } from
  "../../src/engine/claude_sdk_persistent_session_support.js";

const silentLogger = pino({ level: "silent" });

describe("ClaudeRuntimeFollowupWatchdog ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("keeps local ownership after a later foreign input is observed", () => {
    const { watchdog } = makeWatchdog();
    watchdog.arm("own-turn", { kind: "runtime_followup", id: "delivery-1" });

    watchdog.observeTurnInput({ uuid: "own-turn", originKind: "human" });
    watchdog.observeTurnInput({ uuid: "background-2", originKind: "task-notification" });

    expect(watchdog.observesForeignTurn("own-turn")).toBe(false);
    expect(watchdog.observesTurnOrigin("own-turn", "task-notification")).toBe(false);

    watchdog.observeTurnResult({ inputUuid: "own-turn", originKind: undefined });
    watchdog.resultArrived("own-turn");
    watchdog.arm("next-turn", { kind: "runtime_followup", id: "delivery-2" });
    expect(watchdog.observesForeignTurn("next-turn")).toBe(false);
  });

  it("treats foreground progress as proof of ownership when the SDK input echo is absent", async () => {
    const { watchdog, interrupt } = makeWatchdog();
    watchdog.arm("own-turn", { kind: "runtime_followup", id: "delivery-1" });

    watchdog.observeProgress("own-turn", { type: "text", text: "working" });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(interrupt).not.toHaveBeenCalled();
  });

  it("keeps a foreign turn ahead of the local input until the local input is observed", () => {
    const { watchdog } = makeWatchdog();
    watchdog.observeTurnInput({
      uuid: "background-1",
      originKind: "task-notification",
    });
    watchdog.arm("own-turn", { kind: "runtime_followup", id: "delivery-1" });

    expect(watchdog.observesForeignTurn("own-turn")).toBe(true);
    expect(watchdog.observesTurnOrigin("own-turn", "task-notification")).toBe(true);

    watchdog.observeTurnInput({ uuid: "own-turn", originKind: "human" });

    expect(watchdog.observesForeignTurn("own-turn")).toBe(false);
    expect(watchdog.observesTurnOrigin("own-turn", "task-notification")).toBe(false);
  });

  it("excludes synthetic and tool-result-only user frames from turn ownership", () => {
    expect(isTurnStartingUserInput({
      type: "user",
      isSynthetic: true,
      message: { content: "synthetic" },
    })).toBe(false);
    expect(isTurnStartingUserInput({
      type: "user",
      origin: { kind: "human" },
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }],
      },
    })).toBe(false);
    expect(isTurnStartingUserInput({
      type: "user",
      origin: { kind: "peer" },
      message: { content: "real remote trigger" },
    })).toBe(true);
  });
});

function makeWatchdog() {
  const interrupt = vi.fn(async () => ({ still_queued: [] }));
  const close = vi.fn(async () => undefined);
  return {
    interrupt,
    close,
    watchdog: new ClaudeRuntimeFollowupWatchdog({
      timeoutMs: 30_000,
      resultWaitMs: 10,
      logger: silentLogger,
      interrupt,
      close,
    }),
  };
}

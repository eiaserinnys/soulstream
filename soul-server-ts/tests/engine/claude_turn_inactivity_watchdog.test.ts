import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeTurnInactivityWatchdog } from
  "../../src/engine/claude_turn_inactivity_watchdog.js";

describe("ClaudeTurnInactivityWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews the full inactivity interval on every activity", async () => {
    const onInactive = vi.fn(async () => undefined);
    const watchdog = new ClaudeTurnInactivityWatchdog({ timeoutMs: 600_000, onInactive });
    watchdog.arm("turn-1");

    for (let hour = 0; hour < 8; hour += 1) {
      for (let step = 0; step < 7; step += 1) {
        await vi.advanceTimersByTimeAsync(9 * 60_000);
        watchdog.recordActivity("turn-1");
      }
    }

    expect(onInactive).not.toHaveBeenCalled();
  });

  it("expires after one complete interval without activity", async () => {
    const onInactive = vi.fn(async () => undefined);
    const watchdog = new ClaudeTurnInactivityWatchdog({ timeoutMs: 600_000, onInactive });
    watchdog.arm("turn-1");

    await vi.advanceTimersByTimeAsync(599_999);
    expect(onInactive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(onInactive).toHaveBeenCalledOnce();
    expect(onInactive).toHaveBeenCalledWith("turn-1");
  });

  it("ignores activity from another turn", async () => {
    const onInactive = vi.fn(async () => undefined);
    const watchdog = new ClaudeTurnInactivityWatchdog({ timeoutMs: 600_000, onInactive });
    watchdog.arm("turn-1");
    watchdog.recordActivity("turn-2");

    await vi.advanceTimersByTimeAsync(600_000);

    expect(onInactive).toHaveBeenCalledWith("turn-1");
  });

  it.each([
    { type: "text", text: "agent message" },
    { type: "thinking", thinking: "working" },
    { type: "tool_start", toolName: "Upload" },
    { type: "tool_result", result: "uploaded" },
  ] as const)("counts $type as user-visible foreground activity", async (event) => {
    const onInactive = vi.fn(async () => undefined);
    const watchdog = new ClaudeTurnInactivityWatchdog({ timeoutMs: 600_000, onInactive });
    watchdog.arm("turn-1");
    await vi.advanceTimersByTimeAsync(599_000);
    watchdog.recordEvent("turn-1", event);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onInactive).not.toHaveBeenCalled();
  });

  it("does not count generic progress or background runtime events as foreground activity", async () => {
    const onInactive = vi.fn(async () => undefined);
    const watchdog = new ClaudeTurnInactivityWatchdog({ timeoutMs: 600_000, onInactive });
    watchdog.arm("turn-1");
    await vi.advanceTimersByTimeAsync(599_000);
    watchdog.recordEvent("turn-1", { type: "progress", text: "host is alive" });
    watchdog.recordEvent("turn-1", {
      type: "claude_runtime_task_progress",
      taskId: "background-1",
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onInactive).toHaveBeenCalledWith("turn-1");
  });

  it("keeps a turn alive through 25 minutes of linked foreground Agent progress", async () => {
    const onInactive = vi.fn(async () => undefined);
    const watchdog = new ClaudeTurnInactivityWatchdog({ timeoutMs: 1_200_000, onInactive });
    watchdog.arm("turn-1");

    for (let minute = 0; minute < 25; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      watchdog.recordEvent("turn-1", {
        type: "progress",
        text: "Running subagent",
        foregroundToolUseId: "toolu-agent-1",
      });
    }

    expect(onInactive).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_200_000 - 1);
    expect(onInactive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onInactive).toHaveBeenCalledOnce();
    expect(onInactive).toHaveBeenCalledWith("turn-1");
  });

  it("does not count progress with an empty foreground tool use id", async () => {
    const onInactive = vi.fn(async () => undefined);
    const watchdog = new ClaudeTurnInactivityWatchdog({ timeoutMs: 600_000, onInactive });
    watchdog.arm("turn-1");
    await vi.advanceTimersByTimeAsync(599_000);
    watchdog.recordEvent("turn-1", {
      type: "progress",
      text: "host is alive",
      foregroundToolUseId: "",
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onInactive).toHaveBeenCalledWith("turn-1");
  });

  it("does not transfer a previous turn's linked progress to a newly armed turn", async () => {
    const onInactive = vi.fn(async () => undefined);
    const watchdog = new ClaudeTurnInactivityWatchdog({ timeoutMs: 600_000, onInactive });
    watchdog.arm("turn-1");
    watchdog.recordEvent("turn-1", {
      type: "progress",
      text: "Running subagent",
      foregroundToolUseId: "toolu-agent-1",
    });
    watchdog.clear("turn-1");
    watchdog.arm("turn-2");
    watchdog.recordEvent("turn-1", {
      type: "progress",
      text: "Running subagent",
      foregroundToolUseId: "toolu-agent-1",
    });

    await vi.advanceTimersByTimeAsync(600_000);

    expect(onInactive).toHaveBeenCalledOnce();
    expect(onInactive).toHaveBeenCalledWith("turn-2");
  });
});

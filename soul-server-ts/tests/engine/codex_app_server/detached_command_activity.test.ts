import { describe, expect, it, vi } from "vitest";

import { CodexDetachedCommandActivityTracker } from
  "../../../src/engine/codex_app_server/detached_command_activity.js";
import type { AppServerNotification } from
  "../../../src/engine/codex_app_server/protocol.js";

function commandNotification(
  method: "item/started" | "item/completed",
  itemId: string,
  threadId = "thread-root",
  turnId = "turn-root",
): AppServerNotification {
  return {
    method,
    params: {
      threadId,
      turnId,
      item: {
        type: "commandExecution",
        id: itemId,
        command: "sleep 45",
        status: method === "item/started" ? "inProgress" : "completed",
      },
    },
  };
}

function turnCompleted(
  threadId = "thread-root",
  turnId = "turn-root",
): AppServerNotification {
  return {
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        items: [],
        itemsView: { kind: "full" },
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      },
    },
  };
}

describe("CodexDetachedCommandActivityTracker", () => {
  it("retains only a root command that outlives its turn, with no running TTL", () => {
    let now = 1_000;
    const onTerminalResultExpired = vi.fn();
    const tracker = new CodexDetachedCommandActivityTracker({
      terminalResultRetentionMs: 100,
      now: () => now,
      onTerminalResultExpired,
    });
    tracker.beginForeground("thread-root", "turn-root");
    tracker.observe(commandNotification("item/started", "command-a"));
    expect(tracker.snapshot()).toEqual({
      activeForegroundCount: 1,
      detachedRunningCount: 0,
      retainedTerminalResultCount: 0,
      earliestRetainedTerminalDeadlineAtMs: null,
    });

    tracker.observe(turnCompleted());
    now += 12 * 60 * 60_000;
    expect(tracker.snapshot()).toMatchObject({
      activeForegroundCount: 0,
      detachedRunningCount: 1,
      retainedTerminalResultCount: 0,
    });

    tracker.observe(commandNotification("item/completed", "command-a"));
    expect(tracker.snapshot()).toEqual({
      activeForegroundCount: 0,
      detachedRunningCount: 0,
      retainedTerminalResultCount: 1,
      earliestRetainedTerminalDeadlineAtMs: now + 100,
    });

    tracker.beginForeground("thread-root", "turn-successor");
    now += 99;
    expect(tracker.snapshot()).toMatchObject({
      activeForegroundCount: 1,
      retainedTerminalResultCount: 1,
      earliestRetainedTerminalDeadlineAtMs: now + 1,
    });
    now += 1;
    expect(tracker.snapshot()).toMatchObject({
      activeForegroundCount: 1,
      retainedTerminalResultCount: 0,
      earliestRetainedTerminalDeadlineAtMs: null,
    });
    expect(onTerminalResultExpired).toHaveBeenCalledOnce();
    expect(onTerminalResultExpired).toHaveBeenCalledWith({
      threadId: "thread-root",
      turnId: "turn-root",
      itemId: "command-a",
      deadlineAtMs: now,
      reason: "consumption unobserved / retention expired",
    });
    tracker.snapshot();
    expect(onTerminalResultExpired).toHaveBeenCalledOnce();
  });

  it("does not retain foreground-completed or foreign-thread commands", () => {
    const tracker = new CodexDetachedCommandActivityTracker({
      terminalResultRetentionMs: 100,
    });
    tracker.beginForeground("thread-root", "turn-root");
    tracker.observe(commandNotification("item/started", "root-done"));
    tracker.observe(commandNotification("item/completed", "root-done"));
    tracker.observe(commandNotification(
      "item/started",
      "child-running",
      "thread-child",
      "turn-child",
    ));
    tracker.observe(turnCompleted());

    expect(tracker.snapshot()).toMatchObject({
      activeForegroundCount: 0,
      detachedRunningCount: 0,
      retainedTerminalResultCount: 0,
    });
  });

  it("ends only the current foreground while preserving known detached work", () => {
    const tracker = new CodexDetachedCommandActivityTracker({
      terminalResultRetentionMs: 100,
    });
    tracker.beginForeground("thread-root", "turn-root");
    tracker.observe(commandNotification("item/started", "command-a"));
    tracker.observe(turnCompleted());

    tracker.beginForeground("thread-root", "turn-successor");
    tracker.observe(commandNotification(
      "item/started",
      "command-successor",
      "thread-root",
      "turn-successor",
    ));
    tracker.endForegroundExecution();

    expect(tracker.snapshot()).toMatchObject({
      activeForegroundCount: 0,
      detachedRunningCount: 2,
      retainedTerminalResultCount: 0,
    });
  });

  it("clears all activity on adapter close", () => {
    const tracker = new CodexDetachedCommandActivityTracker({
      terminalResultRetentionMs: 100,
    });
    tracker.beginForeground("thread-root", "turn-root");
    tracker.observe(commandNotification("item/started", "command-a"));
    tracker.observe(turnCompleted());
    tracker.clear();

    expect(tracker.snapshot()).toMatchObject({
      activeForegroundCount: 0,
      detachedRunningCount: 0,
      retainedTerminalResultCount: 0,
    });
  });
});

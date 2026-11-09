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
  it("expires a running detached command at the turn deadline once", () => {
    let now = 1_000;
    const onDetachedCommandExpired = vi.fn();
    const tracker = new CodexDetachedCommandActivityTracker({
      terminalResultRetentionMs: 100,
      now: () => now,
      onDetachedCommandExpired,
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
    now += 100;
    expect(tracker.snapshot()).toMatchObject({
      activeForegroundCount: 0,
      detachedRunningCount: 0,
      retainedTerminalResultCount: 0,
    });

    expect(onDetachedCommandExpired).toHaveBeenCalledOnce();
    expect(onDetachedCommandExpired).toHaveBeenCalledWith({
      threadId: "thread-root",
      turnId: "turn-root",
      itemId: "command-a",
      deadlineAtMs: now,
    });
    tracker.snapshot();
    expect(onDetachedCommandExpired).toHaveBeenCalledOnce();
  });

  it("keeps the turn deadline when a detached command completes after 29 minutes", () => {
    let now = 1_000;
    const onTerminalResultExpired = vi.fn();
    const tracker = new CodexDetachedCommandActivityTracker({
      terminalResultRetentionMs: 30 * 60_000,
      now: () => now,
      onTerminalResultExpired,
    });
    tracker.beginForeground("thread-root", "turn-root");
    tracker.observe(commandNotification("item/started", "command-a"));
    tracker.observe(turnCompleted());
    const deadlineAtMs = now + 30 * 60_000;
    now += 29 * 60_000;
    tracker.observe(commandNotification("item/completed", "command-a"));
    expect(tracker.snapshot()).toMatchObject({
      detachedRunningCount: 0,
      retainedTerminalResultCount: 1,
      earliestRetainedTerminalDeadlineAtMs: deadlineAtMs,
    });
    now = deadlineAtMs;
    expect(tracker.snapshot()).toMatchObject({ retainedTerminalResultCount: 0 });
    expect(onTerminalResultExpired).toHaveBeenCalledOnce();
    expect(onTerminalResultExpired).toHaveBeenCalledWith({
      threadId: "thread-root", turnId: "turn-root", itemId: "command-a",
      deadlineAtMs, reason: "consumption unobserved / retention expired",
    });
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

import { describe, expect, it } from "vitest";

import { attachClaudeBackgroundDeliveryMetadata } from
  "../../src/engine/claude_background_delivery_metadata.js";
import { attachClaudeBackgroundProvenance } from
  "../../src/engine/claude_background_provenance.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";
import { ClaudePendingNativeNotificationTracker } from
  "../../src/engine/claude_sdk_persistent_session_support.js";

function terminal(taskId: string, toolUseId: string): ClaudeClientEvent {
  const event: ClaudeClientEvent = {
    type: "claude_runtime_task_updated",
    taskId,
    sessionId: "sdk-session",
    patch: { status: "completed" },
  };
  attachClaudeBackgroundProvenance(event, "sdk_membership");
  attachClaudeBackgroundDeliveryMetadata(event, {
    initiatingToolUseId: toolUseId,
    deliveryId: `delivery-${taskId}`, completionId: `completion-${taskId}`,
    relationKey: `relation-${taskId}`, producerTerminalRevision: "1",
    deliveryCreatedAt: "2026-09-07T00:00:00.000Z", source: "runtime",
    storedPayload: {}, storedPayloadHash: "hash",
  });
  return event;
}

function notification(taskId: string, toolUseId: string, uuid: string) {
  return {
    type: "user", uuid, origin: { kind: "task-notification" },
    message: { content: `<task-notification><task-id>${taskId}</task-id><tool-use-id>${toolUseId}</tool-use-id><status>completed</status></task-notification>` },
  };
}

describe("ClaudePendingNativeNotificationTracker", () => {
  it("retains from accepted terminal through exact native input and assistant until Result", () => {
    const tracker = new ClaudePendingNativeNotificationTracker({
      noOutputTimeoutMs: 100, turnInactivityTimeoutMs: 50,
    });
    tracker.observeAcceptedTerminal(terminal("task-a", "tool-a"));
    expect(tracker.pendingCount()).toBe(1);
    tracker.observeSdkMessage(notification("task-a", "tool-a", "input-a"));
    tracker.observeSdkMessage({ type: "assistant", uuid: "assistant-a" });
    expect(tracker.pendingCount()).toBe(1);
    tracker.observeSdkMessage({
      type: "result", user_message_uuid: "input-a",
      origin: { kind: "task-notification" },
    });
    expect(tracker.pendingCount()).toBe(0);
  });

  it("clears a sole UUID-less task-notification Result but not multiple bound inputs", () => {
    const tracker = new ClaudePendingNativeNotificationTracker({
      noOutputTimeoutMs: 100, turnInactivityTimeoutMs: 50,
    });
    tracker.observeAcceptedTerminal(terminal("task-a", "tool-a"));
    tracker.observeAcceptedTerminal(terminal("task-b", "tool-b"));
    tracker.observeSdkMessage(notification("task-a", "tool-a", "input-a"));
    tracker.observeSdkMessage(notification("task-b", "tool-b", "input-b"));
    tracker.observeSdkMessage({ type: "result", origin: { kind: "task-notification" } });
    expect(tracker.pendingCount()).toBe(2);
  });

  it("clears transient state for an assistantless exact Result without inventing consumption", () => {
    const tracker = new ClaudePendingNativeNotificationTracker({
      noOutputTimeoutMs: 100, turnInactivityTimeoutMs: 50,
    });
    tracker.observeAcceptedTerminal(terminal("task-a", "tool-a"));
    tracker.observeSdkMessage(notification("task-a", "tool-a", "input-a"));
    tracker.observeSdkMessage({
      type: "result", user_message_uuid: "input-a",
      origin: { kind: "task-notification" },
    });
    expect(tracker.pendingCount()).toBe(0);
  });

  it("drops only transient activity at the existing no-output/inactivity deadlines", () => {
    let now = 0;
    const tracker = new ClaudePendingNativeNotificationTracker({
      noOutputTimeoutMs: 100, turnInactivityTimeoutMs: 50, now: () => now,
    });
    tracker.observeAcceptedTerminal(terminal("task-a", "tool-a"));
    now = 99;
    expect(tracker.pendingCount()).toBe(1);
    now = 100;
    expect(tracker.pendingCount()).toBe(0);
    tracker.observeAcceptedTerminal(terminal("task-b", "tool-b"));
    tracker.observeSdkMessage(notification("task-b", "tool-b", "input-b"));
    now = 149;
    expect(tracker.pendingCount()).toBe(1);
    now = 150;
    expect(tracker.pendingCount()).toBe(0);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  PUSH_EVENT_MAX_AGE_MS,
  PushNotifier,
  SessionForegroundObserverTracker,
  type NodeRegistryEvent,
} from "../src/index.js";

const NOW_MS = Date.parse("2026-08-07T11:30:00.000Z");

describe("PushNotifier stale event suppression", () => {
  it("skips every push-producing signal when its persisted timestamp is stale", async () => {
    const harness = createHarness();
    const staleTimestamp = (NOW_MS - PUSH_EVENT_MAX_AGE_MS - 1) / 1_000;

    harness.notifier.accept([
      event("completion", {
        type: "session_ended",
        status: "completed",
        timestamp: staleTimestamp,
      }),
      event("question", {
        type: "input_request",
        questions: [{ question: "Continue?", options: [] }],
        timestamp: staleTimestamp,
      }),
      event("plan", {
        type: "claude_runtime_mode_state",
        mode: "plan",
        active: false,
        tool_name: "ExitPlanMode",
        timestamp: staleTimestamp,
      }),
      event("permission", {
        type: "claude_runtime_notification",
        notification_type: "permission",
        message: "Approve Bash?",
        timestamp: staleTimestamp,
      }),
      event("approval", {
        type: "tool_approval_requested",
        tool_name: "Bash",
        timestamp: staleTimestamp,
      }),
    ]);
    await harness.notifier.flush();

    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.warn).toHaveBeenCalledTimes(5);
  });

  it("sends an event at the ten-minute boundary", async () => {
    const harness = createHarness();

    harness.notifier.accept([
      event("completion", {
        type: "session_ended",
        status: "completed",
        created_at: new Date(NOW_MS - PUSH_EVENT_MAX_AGE_MS).toISOString(),
      }),
    ]);
    await harness.notifier.flush();

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.warn).not.toHaveBeenCalled();
  });
});

function createHarness() {
  const send = vi.fn(async () => ({ ok: true, invalidToken: false }));
  const warn = vi.fn();
  return {
    send,
    warn,
    notifier: new PushNotifier({
      provider: { send },
      repository: {
        upsertToken: vi.fn(async () => undefined),
        listTokens: vi.fn(async () => [{ deviceId: "device-1", expoToken: "token-1" }]),
        deleteToken: vi.fn(async () => undefined),
      },
      catalog: {
        findSessionFolderId: () => null,
        listFolders: () => [],
      },
      sessionLookup: () => ({
        session_type: "claude",
        caller_source: "browser",
      }),
      resolveNodeEmail: () => "user@example.com",
      foregroundObservers: new SessionForegroundObserverTracker(),
      onWarning: warn,
      nowMs: () => NOW_MS,
    }),
  };
}

function event(sessionId: string, payload: Record<string, unknown>): NodeRegistryEvent {
  return {
    type: "node_session_event",
    nodeId: "node-a",
    data: { type: "event", agentSessionId: sessionId, event: payload },
  };
}

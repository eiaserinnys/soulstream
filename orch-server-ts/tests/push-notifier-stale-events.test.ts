import { describe, expect, it, vi } from "vitest";
import { PUSH_EVENT_MAX_AGE_MS, PushNotifier, SessionForegroundObserverTracker, type NodeRegistryEvent } from "../src/index.js";

const NOW_MS = Date.parse("2026-08-07T11:30:00.000Z");

describe("PushNotifier session event no-op", () => {
  it("ignores old and current session notification events alike", async () => {
    const send = vi.fn(async () => ({ ok: true, invalidToken: false }));
    const warn = vi.fn();
    const loadSessionReviewState = vi.fn(async () => ({
      sessionType: "claude",
      reviewRequired: true,
    }));
    const notifier = new PushNotifier({
      provider: { send },
      repository: {
        upsertToken: vi.fn(async () => undefined),
        listTokens: vi.fn(async () => [{ deviceId: "device-1", expoToken: "token-1" }]),
        deleteToken: vi.fn(async () => undefined),
      },
      catalog: { findSessionFolderId: () => null, listFolders: () => [] },
      sessionLookup: () => ({ session_type: "claude", caller_source: "browser", review_required: true }),
      loadSessionReviewState,
      resolveNodeEmail: () => "owner@example.com",
      foregroundObservers: new SessionForegroundObserverTracker(),
      onWarning: warn,
      nowMs: () => NOW_MS,
    });

    notifier.accept([
      event("stale", {
        type: "session_ended",
        status: "completed",
        timestamp: (NOW_MS - PUSH_EVENT_MAX_AGE_MS - 1) / 1_000,
      }),
      event("boundary", {
        type: "session_ended",
        status: "completed",
        created_at: new Date(NOW_MS - PUSH_EVENT_MAX_AGE_MS).toISOString(),
      }),
    ]);
    await notifier.flush();

    expect(send).not.toHaveBeenCalled();
    expect(loadSessionReviewState).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

function event(sessionId: string, payload: Record<string, unknown>): NodeRegistryEvent {
  return {
    type: "node_session_event",
    nodeId: "node-a",
    data: {
      type: "event",
      agentSessionId: sessionId,
      event: { _event_id: sessionId, ...payload },
    },
  };
}

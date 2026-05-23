import { describe, expect, it } from "vitest";

import {
  applyNotificationLifecycle,
  createNotificationLifecycleState,
  recordThreadOpened,
  recordTurnStartResponse,
} from "../../../src/engine/codex_app_server/notification_lifecycle.js";
import type {
  AppServerNotification,
  AppServerTurn,
} from "../../../src/engine/codex_app_server/protocol.js";

function turn(
  id: string,
  status: AppServerTurn["status"] = "inProgress",
): AppServerTurn {
  return {
    id,
    items: [],
    itemsView: { kind: "full" },
    status,
    error: status === "failed" ? { message: "turn failed" } : null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1000,
  };
}

function errorNotification(willRetry: boolean): AppServerNotification {
  return {
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry,
      error: { message: willRetry ? "temporary" : "fatal" },
    },
  };
}

describe("Codex app-server notification lifecycle", () => {
  it("suppresses duplicate thread session payloads without reporting side effects", () => {
    let state = createNotificationLifecycleState();

    const first = applyNotificationLifecycle(
      state,
      { method: "thread/started", params: { thread: { id: "thread-1" } } },
      { suppressThreadStartedSession: false },
    );
    expect(first.payloads).toEqual([{ type: "session", session_id: "thread-1" }]);
    expect(first.closeQueue).toBe(false);
    state = first.state;

    const duplicate = applyNotificationLifecycle(
      state,
      { method: "thread/started", params: { thread: { id: "thread-1" } } },
      { suppressThreadStartedSession: false },
    );
    expect(duplicate.payloads).toEqual([]);
    expect(duplicate.state).toBe(state);

    const openedAfterNotification = recordThreadOpened(state, "thread-1");
    expect(openedAfterNotification.emitSession).toBe(false);
    expect(openedAfterNotification.reportSession).toBe(true);
    state = openedAfterNotification.state;

    const openedAgain = recordThreadOpened(state, "thread-1");
    expect(openedAgain.emitSession).toBe(false);
    expect(openedAgain.reportSession).toBe(false);

    const suppressedResumeNotification = applyNotificationLifecycle(
      state,
      { method: "thread/started", params: { thread: { id: "thread-resume" } } },
      { suppressThreadStartedSession: true },
    );
    expect(suppressedResumeNotification.payloads).toEqual([]);
    expect(suppressedResumeNotification.state).toBe(state);
  });

  it("tracks active turn and emits close effect on terminal notifications", () => {
    let state = createNotificationLifecycleState();

    const startResponse = recordTurnStartResponse(
      state,
      "thread-1",
      turn("turn-1", "inProgress"),
    );
    expect(startResponse.closeQueue).toBe(false);
    expect(startResponse.state.activeTurn).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    state = startResponse.state;

    const started = applyNotificationLifecycle(
      state,
      {
        method: "turn/started",
        params: { threadId: "thread-1", turn: turn("turn-2", "inProgress") },
      },
      { suppressThreadStartedSession: false },
    );
    expect(started.state.activeTurn).toEqual({
      threadId: "thread-1",
      turnId: "turn-2",
    });
    expect(started.payloads).toEqual([
      expect.objectContaining({ type: "progress", text: "Codex turn started" }),
    ]);
    state = started.state;

    const retryingError = applyNotificationLifecycle(
      state,
      errorNotification(true),
      { suppressThreadStartedSession: false },
    );
    expect(retryingError.closeQueue).toBe(false);
    expect(retryingError.state.activeTurn).toEqual({
      threadId: "thread-1",
      turnId: "turn-2",
    });
    expect(retryingError.payloads).toEqual([
      expect.objectContaining({ type: "error", will_retry: true }),
    ]);

    const completed = applyNotificationLifecycle(
      retryingError.state,
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: turn("turn-2", "completed") },
      },
      { suppressThreadStartedSession: false },
    );
    expect(completed.closeQueue).toBe(true);
    expect(completed.state.activeTurn).toBeNull();
    expect(completed.payloads).toEqual([
      expect.objectContaining({ type: "complete", status: "completed" }),
    ]);
  });

  it("closes immediately when a start response is already terminal", () => {
    const result = recordTurnStartResponse(
      createNotificationLifecycleState(),
      "thread-1",
      turn("turn-1", "failed"),
    );

    expect(result.closeQueue).toBe(true);
    expect(result.state.activeTurn).toBeNull();
  });

  it("clears active turn and closes on non-retryable errors", () => {
    const started = recordTurnStartResponse(
      createNotificationLifecycleState(),
      "thread-1",
      turn("turn-1", "inProgress"),
    );

    const result = applyNotificationLifecycle(
      started.state,
      errorNotification(false),
      { suppressThreadStartedSession: false },
    );

    expect(result.closeQueue).toBe(true);
    expect(result.state.activeTurn).toBeNull();
    expect(result.payloads).toEqual([
      expect.objectContaining({ type: "error", will_retry: false }),
    ]);
  });
});

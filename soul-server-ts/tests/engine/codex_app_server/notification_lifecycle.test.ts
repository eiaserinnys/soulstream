import { describe, expect, it } from "vitest";

import {
  applyNotificationLifecycle,
  beginNotificationExecution,
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

function errorNotification(
  willRetry: boolean,
  scope: { threadId?: string; turnId?: string } = {
    threadId: "thread-1",
    turnId: "turn-1",
  },
): AppServerNotification {
  return {
    method: "error",
    params: {
      ...scope,
      willRetry,
      error: { message: willRetry ? "temporary" : "fatal" },
    },
  };
}

describe("Codex app-server notification lifecycle", () => {
  it("suppresses duplicate thread session payloads without reporting side effects", () => {
    let state = beginNotificationExecution(
      createNotificationLifecycleState(),
      "thread-1",
    );

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
        params: { threadId: "thread-1", turn: turn("turn-1", "inProgress") },
      },
      { suppressThreadStartedSession: false },
    );
    expect(started.state.activeTurn).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
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
      turnId: "turn-1",
    });
    expect(retryingError.payloads).toEqual([
      expect.objectContaining({ type: "error", will_retry: true }),
    ]);

    const completed = applyNotificationLifecycle(
      retryingError.state,
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: turn("turn-1", "completed") },
      },
      { suppressThreadStartedSession: false },
    );
    expect(completed.closeQueue).toBe(true);
    expect(completed.state.activeTurn).toBeNull();
    expect(completed.payloads).toEqual([
      expect.objectContaining({ type: "complete", status: "completed" }),
    ]);

    const duplicate = applyNotificationLifecycle(
      completed.state,
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: turn("turn-1", "completed") },
      },
      { suppressThreadStartedSession: false },
    );
    expect(duplicate.closeQueue).toBe(false);
    expect(duplicate.payloads).toEqual([]);
  });

  it("does not let notifications select an execution before the thread response", () => {
    const state = createNotificationLifecycleState();

    const childThread = applyNotificationLifecycle(
      state,
      { method: "thread/started", params: { thread: { id: "child-thread" } } },
      { suppressThreadStartedSession: false },
    );
    expect(childThread.state).toBe(state);
    expect(childThread.payloads).toEqual([]);
    expect(childThread.closeQueue).toBe(false);

    const childTurn = applyNotificationLifecycle(
      state,
      {
        method: "turn/started",
        params: { threadId: "child-thread", turn: turn("child-turn") },
      },
      { suppressThreadStartedSession: false },
    );
    expect(childTurn.state).toBe(state);
    expect(childTurn.payloads).toEqual([]);
    expect(childTurn.closeQueue).toBe(false);
  });

  it("keeps child threads and another turn on the root thread outside the active execution", () => {
    const root = recordTurnStartResponse(
      createNotificationLifecycleState(),
      "root-thread",
      turn("root-turn"),
    ).state;

    const foreignNotifications: AppServerNotification[] = [
      {
        method: "turn/started",
        params: { threadId: "child-a", turn: turn("child-a-turn") },
      },
      {
        method: "item/completed",
        params: {
          threadId: "child-a",
          turnId: "child-a-turn",
          item: { type: "agentMessage", id: "child-answer", text: "child final" },
        },
      },
      {
        method: "turn/started",
        params: { threadId: "root-thread", turn: turn("another-root-turn") },
      },
      errorNotification(false, { threadId: "child-b", turnId: "child-b-turn" }),
      {
        method: "turn/completed",
        params: { threadId: "root-thread", turn: turn("previous-turn", "completed") },
      },
    ];

    for (const notification of foreignNotifications) {
      const result = applyNotificationLifecycle(root, notification, {
        suppressThreadStartedSession: false,
      });
      expect(result.state).toBe(root);
      expect(result.payloads).toEqual([]);
      expect(result.closeQueue).toBe(false);
    }
  });

  it("preserves unscoped and one-sided error compatibility without accepting mismatches", () => {
    const active = recordTurnStartResponse(
      createNotificationLifecycleState(),
      "thread-1",
      turn("turn-1"),
    ).state;

    for (const scope of [
      {},
      { threadId: "thread-1" },
      { turnId: "turn-1" },
    ]) {
      const retrying = applyNotificationLifecycle(
        active,
        errorNotification(true, scope),
        { suppressThreadStartedSession: false },
      );
      expect(retrying.state).toBe(active);
      expect(retrying.closeQueue).toBe(false);
      expect(retrying.payloads).toEqual([
        expect.objectContaining({ type: "error", will_retry: true }),
      ]);
    }

    for (const scope of [
      { threadId: "child-thread" },
      { turnId: "previous-turn" },
      { threadId: "thread-1", turnId: "previous-turn" },
    ]) {
      const mismatched = applyNotificationLifecycle(
        active,
        errorNotification(false, scope),
        { suppressThreadStartedSession: false },
      );
      expect(mismatched.state).toBe(active);
      expect(mismatched.closeQueue).toBe(false);
      expect(mismatched.payloads).toEqual([]);
    }

    for (const scope of [
      { threadId: "thread-1" },
      { turnId: "turn-1" },
    ]) {
      const matchingTerminal = applyNotificationLifecycle(
        active,
        errorNotification(false, scope),
        { suppressThreadStartedSession: false },
      );
      expect(matchingTerminal.closeQueue).toBe(true);
      expect(matchingTerminal.state.activeTurn).toBeNull();
      expect(matchingTerminal.payloads).toEqual([
        expect.objectContaining({ type: "error", will_retry: false }),
      ]);
    }

    const unscopedTerminal = applyNotificationLifecycle(
      active,
      errorNotification(false, {}),
      { suppressThreadStartedSession: false },
    );
    expect(unscopedTerminal.closeQueue).toBe(true);
    expect(unscopedTerminal.state.activeTurn).toBeNull();
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

import { describe, expect, it, vi } from "vitest";

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

function tokenUsageNotification(
  threadId: string,
  turnId: string,
  input: {
    total: Partial<{
      totalTokens: number;
      inputTokens: number;
      cachedInputTokens: number;
      cacheWriteInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
    }>;
    last: Partial<{
      totalTokens: number;
      inputTokens: number;
      cachedInputTokens: number;
      cacheWriteInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
    }>;
    modelContextWindow: number | null;
  },
): AppServerNotification {
  const empty = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  return {
    method: "thread/tokenUsage/updated",
    params: {
      threadId,
      turnId,
      tokenUsage: {
        total: { ...empty, ...input.total },
        last: { ...empty, ...input.last },
        modelContextWindow: input.modelContextWindow,
      },
    },
  } as AppServerNotification;
}

describe("Codex app-server notification lifecycle", () => {
  it("uses the last completed assistant message as complete.result", () => {
    let state = recordTurnStartResponse(
      beginNotificationExecution(createNotificationLifecycleState(), "thread-1"),
      "thread-1",
      turn("turn-1"),
    ).state;

    const message = applyNotificationLifecycle(
      state,
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "answer-1", text: "final answer" },
        },
      },
      { suppressThreadStartedSession: false },
    );
    state = message.state;

    const completed = applyNotificationLifecycle(
      state,
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            ...turn("turn-1", "completed"),
            items: [{ type: "agentMessage", id: "answer-1", text: "final answer" }],
          },
        },
      },
      { suppressThreadStartedSession: false },
    );

    expect(completed.payloads).toContainEqual(
      expect.objectContaining({ type: "complete", result: "final answer" }),
    );
  });

  it("holds the V6 token notification silently and emits usage before complete", () => {
    let state = recordTurnStartResponse(
      beginNotificationExecution(createNotificationLifecycleState(), "thread-1"),
      "thread-1",
      turn("turn-1"),
    ).state;
    const onUnknownNotification = vi.fn();
    const fixture: AppServerNotification[] = [
      {
        method: "turn/started",
        params: { threadId: "thread-1", turn: turn("turn-1") },
      },
      tokenUsageNotification("thread-1", "turn-1", {
        total: {
          totalTokens: 14_129,
          inputTokens: 14_124,
          cachedInputTokens: 12_288,
          outputTokens: 5,
        },
        last: {
          totalTokens: 14_129,
          inputTokens: 14_124,
          cachedInputTokens: 12_288,
          outputTokens: 5,
        },
        modelContextWindow: 258_400,
      }),
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            ...turn("turn-1", "completed"),
            items: [{ type: "agentMessage", id: "msg-final", text: "OK" }],
          },
        },
      },
    ];

    const turnStarted = applyNotificationLifecycle(state, fixture[0]!, {
      suppressThreadStartedSession: false,
      onUnknownNotification,
    });
    expect(turnStarted.payloads.map((payload) => payload.type)).toEqual(["progress"]);
    state = turnStarted.state;

    const usageResult = applyNotificationLifecycle(state, fixture[1]!, {
      suppressThreadStartedSession: false,
      onUnknownNotification,
    });
    expect(usageResult.payloads).toEqual([]);
    expect(usageResult.closeQueue).toBe(false);
    expect(onUnknownNotification).not.toHaveBeenCalled();
    state = usageResult.state;

    const completed = applyNotificationLifecycle(state, fixture[2]!, {
      suppressThreadStartedSession: false,
      onUnknownNotification,
    });

    expect(completed.payloads.map((payload) => payload.type)).toEqual([
      "context_usage",
      "complete",
    ]);
    expect(completed.payloads[0]).toMatchObject({
      type: "context_usage",
      used_tokens: 14_129,
      max_tokens: 258_400,
      percent: 5.5,
    });
    expect(completed.payloads[1]).toMatchObject({
      type: "complete",
      usage: {
        input_tokens: 14_124,
        cached_input_tokens: 12_288,
        output_tokens: 5,
        reasoning_output_tokens: 0,
      },
      first_call: { input_tokens: 14_124, cached_input_tokens: 12_288 },
    });
    expect(completed.state.tokenUsage).toBeNull();
  });

  it("uses an estimated notification as the baseline and keeps the latest context", () => {
    let state = recordTurnStartResponse(
      beginNotificationExecution(createNotificationLifecycleState(), "thread-1"),
      "thread-1",
      turn("turn-1"),
    ).state;
    state = applyNotificationLifecycle(
      state,
      tokenUsageNotification("thread-1", "turn-1", {
        total: {
          totalTokens: 12_121_675,
          inputTokens: 12_093_334,
          cachedInputTokens: 11_724_032,
          outputTokens: 28_341,
          reasoningOutputTokens: 9_861,
        },
        last: {
          totalTokens: 46_357,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 258_400,
      }),
      { suppressThreadStartedSession: false },
    ).state;
    state = applyNotificationLifecycle(
      state,
      tokenUsageNotification("thread-1", "turn-1", {
        total: {
          totalTokens: 12_178_716,
          inputTokens: 12_150_161,
          cachedInputTokens: 11_736_320,
          outputTokens: 28_555,
          reasoningOutputTokens: 9_898,
        },
        last: {
          totalTokens: 57_041,
          inputTokens: 56_827,
          cachedInputTokens: 12_288,
          outputTokens: 214,
          reasoningOutputTokens: 37,
        },
        modelContextWindow: 258_400,
      }),
      { suppressThreadStartedSession: false },
    ).state;
    state = applyNotificationLifecycle(
      state,
      tokenUsageNotification("thread-1", "turn-1", {
        total: {
          totalTokens: 12_242_260,
          inputTokens: 12_213_426,
          cachedInputTokens: 11_793_024,
          outputTokens: 28_834,
          reasoningOutputTokens: 9_931,
        },
        last: {
          totalTokens: 63_544,
          inputTokens: 63_265,
          cachedInputTokens: 56_704,
          outputTokens: 279,
          reasoningOutputTokens: 33,
        },
        modelContextWindow: 258_400,
      }),
      { suppressThreadStartedSession: false },
    ).state;

    const completed = applyNotificationLifecycle(
      state,
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: turn("turn-1", "completed") },
      },
      { suppressThreadStartedSession: false },
    );

    expect(completed.payloads[0]).toMatchObject({
      type: "context_usage",
      used_tokens: 63_544,
      max_tokens: 258_400,
      percent: 24.6,
    });
    expect(completed.payloads[1]).toMatchObject({
      type: "complete",
      usage: {
        input_tokens: 120_092,
        cached_input_tokens: 68_992,
        output_tokens: 493,
        reasoning_output_tokens: 70,
      },
      first_call: { input_tokens: 56_827, cached_input_tokens: 12_288 },
    });
  });

  it("marks context estimated when the final notification has no input or output", () => {
    let state = recordTurnStartResponse(
      beginNotificationExecution(createNotificationLifecycleState(), "thread-1"),
      "thread-1",
      turn("turn-1"),
    ).state;
    state = applyNotificationLifecycle(
      state,
      tokenUsageNotification("thread-1", "turn-1", {
        total: {
          totalTokens: 224_420,
          inputTokens: 224_349,
          cachedInputTokens: 223_360,
          outputTokens: 71,
        },
        last: {
          totalTokens: 224_420,
          inputTokens: 224_349,
          cachedInputTokens: 223_360,
          outputTokens: 71,
        },
        modelContextWindow: 258_400,
      }),
      { suppressThreadStartedSession: false },
    ).state;
    state = applyNotificationLifecycle(
      state,
      tokenUsageNotification("thread-1", "turn-1", {
        total: {
          totalTokens: 224_420,
          inputTokens: 224_349,
          cachedInputTokens: 223_360,
          outputTokens: 71,
        },
        last: { totalTokens: 46_357 },
        modelContextWindow: 258_400,
      }),
      { suppressThreadStartedSession: false },
    ).state;

    const completed = applyNotificationLifecycle(
      state,
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: turn("turn-1", "completed") },
      },
      { suppressThreadStartedSession: false },
    );

    expect(completed.payloads[0]).toMatchObject({
      type: "context_usage",
      used_tokens: 46_357,
      max_tokens: 258_400,
      percent: 17.9,
      estimated: true,
    });
    expect(completed.payloads[1]).toMatchObject({
      type: "complete",
      usage: {
        input_tokens: 224_349,
        cached_input_tokens: 223_360,
        output_tokens: 71,
        reasoning_output_tokens: 0,
      },
    });
  });

  it("resets the usage baseline between executions", () => {
    let state = recordTurnStartResponse(
      beginNotificationExecution(createNotificationLifecycleState(), "thread-1"),
      "thread-1",
      turn("turn-1"),
    ).state;
    state = applyNotificationLifecycle(
      state,
      tokenUsageNotification("thread-1", "turn-1", {
        total: { totalTokens: 100, inputTokens: 100 },
        last: { totalTokens: 100, inputTokens: 100 },
        modelContextWindow: 1_000,
      }),
      { suppressThreadStartedSession: false },
    ).state;
    const firstCompleted = applyNotificationLifecycle(
      state,
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: turn("turn-1", "completed") },
      },
      { suppressThreadStartedSession: false },
    );
    expect(firstCompleted.payloads.find((payload) => payload.type === "complete")).toMatchObject({
      type: "complete",
      first_call: { input_tokens: 100, cached_input_tokens: 0 },
    });
    state = firstCompleted.state;

    state = recordTurnStartResponse(
      beginNotificationExecution(state, "thread-1"),
      "thread-1",
      turn("turn-2"),
    ).state;
    const secondExecution = applyNotificationLifecycle(
      state,
      tokenUsageNotification("thread-1", "turn-2", {
        total: { totalTokens: 45, inputTokens: 40, outputTokens: 5 },
        last: { totalTokens: 45, inputTokens: 40, outputTokens: 5 },
        modelContextWindow: 1_000,
      }),
      { suppressThreadStartedSession: false },
    );
    const secondCompleted = applyNotificationLifecycle(
      secondExecution.state,
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: turn("turn-2", "completed") },
      },
      { suppressThreadStartedSession: false },
    );

    expect(secondExecution.state.tokenUsage?.baseline).toMatchObject({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(secondCompleted.payloads.find((payload) => payload.type === "complete")).toMatchObject({
      type: "complete",
      first_call: { input_tokens: 40, cached_input_tokens: 0 },
    });
  });

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
    let state = beginNotificationExecution(
      createNotificationLifecycleState(),
      "thread-1",
    );

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
      beginNotificationExecution(createNotificationLifecycleState(), "root-thread"),
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
      tokenUsageNotification("child-a", "child-a-turn", {
        total: { totalTokens: 10, inputTokens: 10 },
        last: { totalTokens: 10, inputTokens: 10 },
        modelContextWindow: 1_000,
      }),
      tokenUsageNotification("root-thread", "previous-turn", {
        total: { totalTokens: 20, inputTokens: 20 },
        last: { totalTokens: 20, inputTokens: 20 },
        modelContextWindow: 1_000,
      }),
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
      beginNotificationExecution(createNotificationLifecycleState(), "thread-1"),
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
      beginNotificationExecution(createNotificationLifecycleState(), "thread-1"),
      "thread-1",
      turn("turn-1", "failed"),
    );

    expect(result.closeQueue).toBe(true);
    expect(result.state.activeTurn).toBeNull();
  });

  it("does not reopen an execution after terminal notification beats the start response", () => {
    let state = beginNotificationExecution(
      createNotificationLifecycleState(),
      "thread-1",
    );
    state = applyNotificationLifecycle(
      state,
      {
        method: "turn/started",
        params: { threadId: "thread-1", turn: turn("turn-1") },
      },
      { suppressThreadStartedSession: false },
    ).state;
    const terminal = applyNotificationLifecycle(
      state,
      {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: turn("turn-1", "completed") },
      },
      { suppressThreadStartedSession: false },
    );

    const lateResponse = recordTurnStartResponse(
      terminal.state,
      "thread-1",
      turn("turn-1"),
    );

    expect(lateResponse.state).toBe(terminal.state);
    expect(lateResponse.state.executionThreadId).toBeNull();
    expect(lateResponse.state.activeTurn).toBeNull();
    expect(lateResponse.closeQueue).toBe(false);
  });

  it("clears active turn and closes on non-retryable errors", () => {
    const started = recordTurnStartResponse(
      beginNotificationExecution(createNotificationLifecycleState(), "thread-1"),
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

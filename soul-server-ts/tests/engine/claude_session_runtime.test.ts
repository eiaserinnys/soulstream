import { describe, expect, it, vi } from "vitest";

import {
  ClaudeSessionRuntime,
  type ClaudeInterruptReceipt,
  type ClaudePersistentQuery,
} from "../../src/engine/claude_session_runtime.js";

function makeSubject(receipt: ClaudeInterruptReceipt = { still_queued: [] }) {
  const query: ClaudePersistentQuery = {
    interrupt: vi.fn().mockResolvedValue(receipt),
    close: vi.fn(),
  };
  const runtime = new ClaudeSessionRuntime<string>(() => query);
  return { runtime, query };
}

describe("ClaudeSessionRuntime", () => {
  it("Result는 foreground만 끝내고 Query와 input queue를 닫지 않는다", async () => {
    const { runtime, query } = makeSubject();
    runtime.setSessionId("claude-session-1");
    runtime.enqueueInput({ uuid: "turn-1", payloadHash: "hash-1", message: "first" });
    runtime.beginForegroundTurn("turn-1");
    runtime.observeResult({ userMessageUuid: "turn-1", interrupted: false });
    runtime.finishForegroundResult();

    expect(runtime.snapshot()).toMatchObject({
      sessionId: "claude-session-1",
      foregroundPhase: "drain",
      queryLifecycle: "open",
    });
    expect(query.close).not.toHaveBeenCalled();
    expect(runtime.enqueueInput({
      uuid: "turn-2",
      payloadHash: "hash-2",
      message: "second",
    })).toBe(true);
    await expect(runtime.inputQueue.next()).resolves.toEqual({
      done: false,
      value: "first",
    });
  });

  it("interrupt receipt가 UUID를 생략해도 로컬 큐에서 지우지 않고 한 번만 settle한다", async () => {
    const { runtime, query } = makeSubject({ still_queued: [] });
    runtime.enqueueInput({ uuid: "turn-1", payloadHash: "hash-1", message: "first" });
    runtime.beginForegroundTurn("turn-1");

    await expect(runtime.interruptThenDeliver({
      uuid: "steer-1",
      payloadHash: "hash-steer",
      message: "steer",
    })).resolves.toEqual({ still_queued: [] });

    expect(query.interrupt).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().pendingInputs).toContainEqual({
      uuid: "steer-1",
      payloadHash: "hash-steer",
      state: "queued",
    });

    runtime.observeResult({ interrupted: true });
    runtime.finishForegroundResult();
    runtime.beginForegroundTurn("steer-1");
    runtime.observeResult({ userMessageUuid: "steer-1", interrupted: false });
    runtime.finishForegroundResult();

    expect(runtime.enqueueInput({
      uuid: "steer-1",
      payloadHash: "hash-steer",
      message: "steer",
    })).toBe(false);
    expect(runtime.snapshot().pendingInputs).toContainEqual({
      uuid: "steer-1",
      payloadHash: "hash-steer",
      state: "settled",
    });
  });

  it("background replace-set은 foreground Result와 직교한다", () => {
    const { runtime } = makeSubject();
    runtime.enqueueInput({ uuid: "turn-1", payloadHash: "hash-1", message: "first" });
    runtime.beginForegroundTurn("turn-1");
    runtime.replaceBackgroundTasks(["bg-2", "bg-1"]);
    runtime.observeResult({ userMessageUuid: "turn-1", interrupted: false });

    expect(runtime.snapshot()).toMatchObject({
      foregroundPhase: "turn_result",
      backgroundTaskIds: ["bg-1", "bg-2"],
    });

    runtime.finishForegroundResult();
    runtime.replaceBackgroundTasks([]);
    expect(runtime.snapshot()).toMatchObject({
      foregroundPhase: "drain",
      backgroundTaskIds: [],
      queryLifecycle: "open",
    });
  });

  it("detached Result는 foreground phase를 바꾸지 않고 UUID 중복을 차단한다", () => {
    const { runtime } = makeSubject();
    runtime.enqueueInput({ uuid: "turn-1", payloadHash: "hash-1", message: "first" });
    runtime.beginForegroundTurn("turn-1");
    runtime.enqueueInput({ uuid: "queued-2", payloadHash: "hash-2", message: "second" });

    expect(runtime.observeDetachedResult("queued-2")).toBe("settled");
    expect(runtime.observeDetachedResult("queued-2")).toBe("duplicate");
    expect(runtime.observeDetachedResult("unknown")).toBe("unknown");
    expect(runtime.snapshot().foregroundPhase).toBe("generating");
  });

  it("drain phase input starts the next turn without interrupting the settled turn", () => {
    const { runtime, query } = makeSubject();
    runtime.enqueueInput({ uuid: "turn-1", payloadHash: "hash-1", message: "first" });
    runtime.beginForegroundTurn("turn-1");
    runtime.observeResult({ userMessageUuid: "turn-1", interrupted: false });
    runtime.finishForegroundResult();

    expect(runtime.enqueueInput({
      uuid: "turn-2",
      payloadHash: "hash-2",
      message: "second",
    })).toBe(true);
    runtime.beginForegroundTurn("turn-2");

    expect(runtime.snapshot().foregroundPhase).toBe("generating");
    expect(query.interrupt).not.toHaveBeenCalled();
  });

  it("idle/generating/interrupting/turn_result/drain phase transitions are explicit", async () => {
    const { runtime } = makeSubject();
    expect(runtime.snapshot().foregroundPhase).toBe("idle");

    runtime.enqueueInput({ uuid: "turn-1", payloadHash: "hash-1", message: "first" });
    runtime.beginForegroundTurn("turn-1");
    expect(runtime.snapshot().foregroundPhase).toBe("generating");

    await runtime.interruptThenDeliver({
      uuid: "turn-2",
      payloadHash: "hash-2",
      message: "second",
    });
    expect(runtime.snapshot().foregroundPhase).toBe("interrupting");

    runtime.observeResult({ userMessageUuid: "turn-1", interrupted: true });
    expect(runtime.snapshot().foregroundPhase).toBe("turn_result");

    runtime.finishForegroundResult();
    expect(runtime.snapshot().foregroundPhase).toBe("drain");

    runtime.finishDrain();
    expect(runtime.snapshot().foregroundPhase).toBe("idle");
  });

  it("명시 cancel/shutdown/fatal만 Query를 닫는다", async () => {
    const { runtime, query } = makeSubject();
    runtime.close("explicit_cancel");

    expect(query.close).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().queryLifecycle).toBe("closed");
    await expect(runtime.inputQueue.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(() => runtime.enqueueInput({
      uuid: "late",
      payloadHash: "late",
      message: "late",
    })).toThrow("Persistent Claude Query is closed");
  });
});

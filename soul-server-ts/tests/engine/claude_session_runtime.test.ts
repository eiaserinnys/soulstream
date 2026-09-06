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

function runtimeInput(uuid: string, payloadHash: string, message: string) {
  return { uuid, payloadHash, turnOwner: { kind: "initial_prompt", id: uuid }, message };
}

describe("ClaudeSessionRuntime", () => {
  it("admits exact retries by state but rejects payload or owner conflicts", () => {
    const { runtime } = makeSubject();
    const turnOwner = { kind: "runtime_followup", id: "delivery-1" };
    const input = {
      uuid: "retry-1",
      payloadHash: "canonical-payload",
      turnOwner,
      message: "follow-up",
    };

    expect(runtime.enqueueInput(input)).toEqual({ enqueued: true, state: "queued" });
    expect(runtime.enqueueInput(input)).toEqual({ enqueued: false, state: "queued" });
    runtime.beginForegroundTurn(input.uuid);
    expect(runtime.enqueueInput(input)).toEqual({ enqueued: false, state: "submitted" });
    runtime.observeResult({ userMessageUuid: input.uuid, interrupted: false });
    runtime.finishForegroundResult();
    expect(runtime.enqueueInput(input)).toEqual({ enqueued: false, state: "settled" });

    expect(() => runtime.enqueueInput({
      ...input,
      payloadHash: "different-payload",
    })).toThrow(/payload/i);
    expect(() => runtime.enqueueInput({
      ...input,
      turnOwner: { kind: "runtime_followup", id: "delivery-2" },
    })).toThrow(/owner/i);

    expect(() => runtime.beginForegroundTurn(input.uuid)).toThrow(/settled/i);
    const successor = {
      uuid: "retry-successor",
      payloadHash: "successor-payload",
      turnOwner: { kind: "initial_prompt", id: "retry-successor" },
      message: "successor",
    };
    expect(runtime.enqueueInput(successor)).toEqual({ enqueued: true, state: "queued" });
    runtime.beginForegroundTurn(successor.uuid);
    expect(runtime.snapshot().foregroundPhase).toBe("generating");
  });

  it("merges tool-boundary input into the active result without changing its owner", async () => {
    const { runtime, query } = makeSubject();
    runtime.enqueueInput(runtimeInput("foreground", "hash-1", "first"));
    runtime.beginForegroundTurn("foreground");

    expect(runtime.enqueueForegroundContinuation(
      runtimeInput("machine-report", "hash-2", "report"),
    )).toBe(true);
    expect(runtime.snapshot().pendingInputs).toContainEqual({
      uuid: "machine-report",
      payloadHash: "hash-2",
      turnOwner: { kind: "initial_prompt", id: "machine-report" },
      state: "merged",
    });
    expect(runtime.isForegroundResultOwner("foreground")).toBe(true);
    expect(runtime.isForegroundResultOwner("machine-report")).toBe(true);

    runtime.observeResult({ userMessageUuid: "foreground", interrupted: false });
    runtime.settleMergedInputs();
    runtime.finishForegroundResult();

    expect(runtime.snapshot().pendingInputs).toEqual([
      expect.objectContaining({ uuid: "foreground", state: "settled" }),
      expect.objectContaining({ uuid: "machine-report", state: "settled" }),
    ]);
    expect(query.interrupt).not.toHaveBeenCalled();
    await expect(runtime.inputQueue.next()).resolves.toEqual({ done: false, value: "first" });
    await expect(runtime.inputQueue.next()).resolves.toEqual({ done: false, value: "report" });
  });

  it("Result는 foreground만 끝내고 Query와 input queue를 닫지 않는다", async () => {
    const { runtime, query } = makeSubject();
    runtime.setSessionId("claude-session-1");
    runtime.enqueueInput(runtimeInput("turn-1", "hash-1", "first"));
    runtime.beginForegroundTurn("turn-1");
    runtime.observeResult({ userMessageUuid: "turn-1", interrupted: false });
    runtime.finishForegroundResult();

    expect(runtime.snapshot()).toMatchObject({
      sessionId: "claude-session-1",
      foregroundPhase: "drain",
      queryLifecycle: "open",
    });
    expect(query.close).not.toHaveBeenCalled();
    expect(runtime.enqueueInput(runtimeInput("turn-2", "hash-2", "second"))).toEqual(
      { enqueued: true, state: "queued" },
    );
    await expect(runtime.inputQueue.next()).resolves.toEqual({
      done: false,
      value: "first",
    });
  });

  it("interrupt receipt가 UUID를 생략해도 로컬 큐에서 지우지 않고 한 번만 settle한다", async () => {
    const { runtime, query } = makeSubject({ still_queued: [] });
    runtime.enqueueInput(runtimeInput("turn-1", "hash-1", "first"));
    runtime.beginForegroundTurn("turn-1");

    await expect(runtime.interruptThenDeliver(
      runtimeInput("steer-1", "hash-steer", "steer"),
    )).resolves.toEqual({ still_queued: [] });

    expect(query.interrupt).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().pendingInputs).toContainEqual({
      uuid: "steer-1",
      payloadHash: "hash-steer",
      turnOwner: { kind: "initial_prompt", id: "steer-1" },
      state: "queued",
    });

    runtime.observeResult({ interrupted: true });
    runtime.finishForegroundResult();
    runtime.beginForegroundTurn("steer-1");
    runtime.observeResult({ userMessageUuid: "steer-1", interrupted: false });
    runtime.finishForegroundResult();

    expect(runtime.enqueueInput(runtimeInput("steer-1", "hash-steer", "steer"))).toEqual(
      { enqueued: false, state: "settled" },
    );
    expect(runtime.snapshot().pendingInputs).toContainEqual({
      uuid: "steer-1",
      payloadHash: "hash-steer",
      turnOwner: { kind: "initial_prompt", id: "steer-1" },
      state: "settled",
    });
  });

  it("이전 턴의 늦은 interrupt receipt는 다음 턴 ledger를 바꾸지 않는다", async () => {
    let releaseReceipt!: (receipt: ClaudeInterruptReceipt) => void;
    const query: ClaudePersistentQuery = {
      interrupt: vi.fn(async () => await new Promise<ClaudeInterruptReceipt>((resolve) => {
        releaseReceipt = resolve;
      })),
      close: vi.fn(),
    };
    const runtime = new ClaudeSessionRuntime<string>(() => query);
    runtime.enqueueInput(runtimeInput("turn-1", "hash-1", "first"));
    runtime.beginForegroundTurn("turn-1");

    const staleReceipt = vi.fn();
    const interruption = runtime.interruptForeground(staleReceipt);
    await vi.waitFor(() => expect(query.interrupt).toHaveBeenCalledTimes(1));
    runtime.observeResult({ userMessageUuid: "turn-1", interrupted: true });
    runtime.finishForegroundResult();
    runtime.enqueueInput(runtimeInput("turn-2", "hash-2", "second"));
    runtime.beginForegroundTurn("turn-2");
    const beforeLateReceipt = runtime.snapshot();

    releaseReceipt({ still_queued: ["turn-2"] });
    await interruption;

    expect(runtime.snapshot()).toEqual(beforeLateReceipt);
    expect(staleReceipt).toHaveBeenCalledWith({
      interruptedTurnUuid: "turn-1",
      currentTurnUuid: "turn-2",
    });
    expect(runtime.snapshot()).toMatchObject({
      foregroundPhase: "generating",
      interruptReceiptObserved: false,
      pendingInputs: expect.arrayContaining([
        expect.objectContaining({ uuid: "turn-2", state: "submitted" }),
      ]),
    });
  });

  it("background replace-set은 foreground Result와 직교한다", () => {
    const { runtime } = makeSubject();
    runtime.enqueueInput(runtimeInput("turn-1", "hash-1", "first"));
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
    runtime.enqueueInput(runtimeInput("turn-1", "hash-1", "first"));
    runtime.beginForegroundTurn("turn-1");
    runtime.enqueueInput(runtimeInput("queued-2", "hash-2", "second"));

    expect(runtime.observeDetachedResult("queued-2")).toBe("settled");
    expect(runtime.observeDetachedResult("queued-2")).toBe("duplicate");
    expect(runtime.observeDetachedResult("unknown")).toBe("unknown");
    expect(runtime.snapshot().foregroundPhase).toBe("generating");
  });

  it("rejects a consumed UUID with a conflicting replay payload", async () => {
    const { runtime, query } = makeSubject();
    runtime.enqueueInput({
      uuid: "runtime-followup-consumed",
      payloadHash: "canonical-before-restart",
      turnOwner: { kind: "runtime_followup", id: "delivery-consumed" },
      message: "consumed follow-up",
    });
    runtime.beginForegroundTurn("runtime-followup-consumed");
    runtime.observeResult({
      userMessageUuid: "runtime-followup-consumed",
      interrupted: false,
    });
    runtime.finishForegroundResult();

    expect(() => runtime.enqueueInput({
      uuid: "runtime-followup-consumed",
      payloadHash: "rebuilt-after-restart",
      turnOwner: { kind: "runtime_followup", id: "delivery-consumed" },
      message: "stale replay",
    })).toThrow(/payload/i);
    expect(runtime.snapshot().pendingInputs).toContainEqual({
      uuid: "runtime-followup-consumed",
      payloadHash: "canonical-before-restart",
      turnOwner: { kind: "runtime_followup", id: "delivery-consumed" },
      state: "settled",
    });
    expect(query.close).not.toHaveBeenCalled();
  });

  it("drain phase input starts the next turn without interrupting the settled turn", () => {
    const { runtime, query } = makeSubject();
    runtime.enqueueInput(runtimeInput("turn-1", "hash-1", "first"));
    runtime.beginForegroundTurn("turn-1");
    runtime.observeResult({ userMessageUuid: "turn-1", interrupted: false });
    runtime.finishForegroundResult();

    expect(runtime.enqueueInput(runtimeInput("turn-2", "hash-2", "second"))).toEqual(
      { enqueued: true, state: "queued" },
    );
    runtime.beginForegroundTurn("turn-2");

    expect(runtime.snapshot().foregroundPhase).toBe("generating");
    expect(query.interrupt).not.toHaveBeenCalled();
  });

  it("idle/generating/interrupting/turn_result/drain phase transitions are explicit", async () => {
    const { runtime } = makeSubject();
    expect(runtime.snapshot().foregroundPhase).toBe("idle");

    runtime.enqueueInput(runtimeInput("turn-1", "hash-1", "first"));
    runtime.beginForegroundTurn("turn-1");
    expect(runtime.snapshot().foregroundPhase).toBe("generating");

    await runtime.interruptThenDeliver(runtimeInput("turn-2", "hash-2", "second"));
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
      turnOwner: { kind: "initial_prompt", id: "late" },
      message: "late",
    })).toThrow("Persistent Claude Query is closed");
  });
});

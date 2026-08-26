import { describe, expect, it, vi } from "vitest";

import { runnerCommandResultFrame } from "../../src/runner/frame_protocol.js";
import { RunnerProcessEngineProxy } from
  "../../src/runner/runner_process_engine_proxy.js";
import { RunnerProcessDispatcher } from
  "../../src/runner/runner_process_dispatcher.js";

describe("RunnerProcessEngineProxy", () => {
  it("gives compact the configured turn boundary without widening control commands", async () => {
    const turnTimeoutMs = 1_800_000;
    const controlTimeoutMs = 30_000;
    const request = vi.fn(async (frame: { commandId: string; kind: string }) => (
      runnerCommandResultFrame(frame.commandId, {
        status: "ok",
        ...(frame.kind === "interrupt" ? { data: { interrupted: true } } : {}),
      })
    ));
    const dispatcher = Object.create(RunnerProcessDispatcher.prototype) as RunnerProcessDispatcher;
    Object.assign(dispatcher, {
      ready: Promise.resolve(),
      spawnInput: {
        sessionId: "session-a",
        claudeRuntimeTurnTimeoutMs: turnTimeoutMs,
      },
      connection: { request },
      options: {},
      requestLifetimes: new Map(),
    });
    const proxy = new RunnerProcessEngineProxy(
      "claude",
      "/workspace/a",
      dispatcher,
    );

    await proxy.compact("backend-session-a");
    await expect(proxy.interrupt()).resolves.toBe(true);

    const observedTimeouts = request.mock.calls.map(([, options]) => options.timeoutMs);
    expect({
      observedTimeouts,
      compactToControlRatio: observedTimeouts[0] / observedTimeouts[1],
    }).toEqual({
      observedTimeouts: [turnTimeoutMs, controlTimeoutMs],
      compactToControlRatio: 60,
    });
  });

  it("routes lifecycle and delivery capabilities through the process dispatcher", async () => {
    const dispatcher = {
      interrupt: vi.fn(async () => true),
      close: vi.fn(async () => {}),
      invoke: vi.fn(async (capability: string) => {
        if (capability === "intervene") {
          return { status: "delivered", mechanism: "active_turn" };
        }
        if (capability === "deliverInputResponse") return { status: "delivered" };
        if (capability === "deliverToolApproval") return { status: "already_resolved" };
        if (capability === "detachedClaudeRuntimeActivity") {
          return {
            foregroundPhase: "post_result_drain",
            queryLifecycle: "open",
            backgroundTaskCount: 1,
            pendingInputRequestCount: 0,
            pendingRuntimeSignalCount: 0,
          };
        }
        return undefined;
      }),
    };
    const proxy = new RunnerProcessEngineProxy("claude", "/workspace/a", dispatcher as never);

    await expect(proxy.interrupt()).resolves.toBe(true);
    await expect(proxy.intervene({ prompt: "redirect" })).resolves.toEqual({
      status: "delivered",
      mechanism: "active_turn",
    });
    await expect(proxy.deliverInputResponse("request-1", { answer: "yes" })).resolves.toEqual({
      status: "delivered",
    });
    await expect(proxy.deliverToolApproval("approval-1", "approved")).resolves.toEqual({
      status: "already_resolved",
    });
    await expect(proxy.detachedClaudeRuntimeActivity()).resolves.toMatchObject({
      backgroundTaskCount: 1,
    });
    await proxy.close();

    expect(proxy.detachedClaudeRuntime).toBe(true);
    expect(dispatcher.invoke).toHaveBeenNthCalledWith(
      1,
      "intervene",
      [{ prompt: "redirect" }],
    );
    expect(dispatcher.invoke).toHaveBeenNthCalledWith(
      2,
      "deliverInputResponse",
      ["request-1", { answer: "yes" }],
    );
    expect(dispatcher.invoke).toHaveBeenNthCalledWith(
      3,
      "deliverToolApproval",
      ["approval-1", "approved", {}],
    );
    expect(dispatcher.invoke).toHaveBeenNthCalledWith(
      4,
      "detachedClaudeRuntimeActivity",
      [],
    );
  });

  it("normalizes a pre-contract child response during a rolling restart", async () => {
    const dispatcher = {
      invoke: vi.fn().mockResolvedValue({ status: "not_supported" }),
    };
    const proxy = new RunnerProcessEngineProxy("codex", "/workspace/a", dispatcher as never);

    await expect(proxy.intervene({ prompt: "redirect" })).resolves.toEqual({
      status: "not_delivered",
      mechanism: "unsupported",
      reason: "not_supported",
      message: "Runner child does not expose the intervention operation",
    });
  });

  it.each([
    ["not_supported", { status: "not_supported" }],
    ["undefined", undefined],
  ])("normalizes pre-contract detached runtime activity %s to null", async (_label, result) => {
    const dispatcher = {
      invoke: vi.fn().mockResolvedValue(result),
    };
    const proxy = new RunnerProcessEngineProxy("claude", "/workspace/a", dispatcher as never);

    await expect(proxy.detachedClaudeRuntimeActivity()).resolves.toBeNull();
  });

  it("does not claim detached Claude semantics for other backends", () => {
    const proxy = new RunnerProcessEngineProxy("codex", "/workspace/a", {} as never);
    expect(proxy.detachedClaudeRuntime).toBeUndefined();
  });

  it("does not claim detached runtime retention for an offline Claude replay", () => {
    const proxy = new RunnerProcessEngineProxy(
      "claude",
      "/workspace/a",
      {} as never,
      { retainDetachedRuntime: false },
    );

    expect(proxy.detachedClaudeRuntime).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";

import { RunnerProcessEngineProxy } from
  "../../src/runner/runner_process_engine_proxy.js";

describe("RunnerProcessEngineProxy", () => {
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

  it("does not claim detached Claude semantics for other backends", () => {
    const proxy = new RunnerProcessEngineProxy("codex", "/workspace/a", {} as never);
    expect(proxy.detachedClaudeRuntime).toBeUndefined();
  });
});

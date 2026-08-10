import { describe, expect, it, vi } from "vitest";

import { runnerControlResponseFrame } from "../../src/runner/frame_protocol.js";
import { RunnerHostRequestClient } from "../../src/runner/runner_host_request_client.js";

describe("RunnerHostRequestClient", () => {
  it("retries with one correlation id and returns a recovered host response", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("connection closed"))
      .mockImplementationOnce(async (frame) => runnerControlResponseFrame(
        frame.correlationId,
        { status: "ok", data: ["entry"] },
      ));
    const client = new RunnerHostRequestClient(
      () => ({ request } as never),
      async () => {},
    );

    await expect(client.call("session_store", "load", [{ sessionId: "s" }], {
      timeoutMs: 50,
      attempts: 2,
      retryDelayMs: 0,
    })).resolves.toEqual(["entry"]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0].correlationId).toBe(
      request.mock.calls[1]?.[0].correlationId,
    );
  });

  it("bounds server-absent retries instead of blocking forever", async () => {
    const delay = vi.fn(async () => {});
    const client = new RunnerHostRequestClient(() => undefined, delay);

    await expect(client.call("session_store", "append", [{}, []], {
      timeoutMs: 10,
      attempts: 3,
      retryDelayMs: 1,
    })).rejects.toThrow("failed after 3 attempts");
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it("aborts retry immediately and leaves no hidden pending loop", async () => {
    const controller = new AbortController();
    const delay = vi.fn(async () => controller.abort(new Error("runner stopping")));
    const client = new RunnerHostRequestClient(() => undefined, delay);

    await expect(client.call("snapshot", "persist", [{}], {
      signal: controller.signal,
      timeoutMs: 10,
      attempts: 3,
    })).rejects.toThrow("runner stopping");
    expect(delay).toHaveBeenCalledOnce();
  });

  it("applies one deadline across retries when a connected host stops responding", async () => {
    const request = vi.fn(async (_frame, options: { signal: AbortSignal }) =>
      await new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      }));
    const client = new RunnerHostRequestClient(() => ({ request } as never));

    await expect(client.call("session_store", "load", [{}], {
      timeoutMs: 10,
      attempts: 61,
      retryDelayMs: 1,
    })).rejects.toThrow("timed out after 10ms");
    expect(request).toHaveBeenCalledOnce();
  });
});

import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSseStream } from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createSseStream", () => {
  it("destroys a stalled stream and fires existing close cleanup", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    const { stream, push } = createSseStream({
      highWaterMark: 4,
      stallTimeoutMs: 100,
    });
    stream.on("close", cleanup);
    const closed = once(stream, "close");

    expect(push("data")).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await closed;

    expect(stream.destroyed).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("clears the stall deadline when consumption resumes", async () => {
    vi.useFakeTimers();
    const { stream, push } = createSseStream({
      highWaterMark: 4,
      stallTimeoutMs: 100,
    });

    expect(push("data")).toBe(false);
    expect(stream.read()?.toString()).toBe("data");
    await vi.advanceTimersByTimeAsync(101);

    expect(stream.destroyed).toBe(false);
    stream.destroy();
  });

  it("makes push a no-op after the stream is destroyed", async () => {
    const { stream, push } = createSseStream({
      highWaterMark: 4,
      stallTimeoutMs: 100,
    });
    const closed = once(stream, "close");
    stream.destroy();
    await closed;

    expect(push("data")).toBe(false);
    expect(stream.readableLength).toBe(0);
  });
});

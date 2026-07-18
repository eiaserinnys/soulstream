import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithProjectionRetry } from "./projection-retry";

describe("fetchWithProjectionRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries only 404 projection misses after 100, 250, and 500ms", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const pending = fetchWithProjectionRetry(fetchMock);
    await vi.advanceTimersByTimeAsync(99);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns non-404 failures without retrying", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));

    await expect(fetchWithProjectionRetry(fetchMock)).resolves.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight retry wait", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    const pending = fetchWithProjectionRetry(fetchMock, controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

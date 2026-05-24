import { describe, expect, it } from "vitest";
import { runGuardedLoadMore, shouldLoadMoreFromVirtualItems } from "./load-more-guard";

describe("runGuardedLoadMore", () => {
  it("suppresses duplicate load calls while a request is pending", async () => {
    let resolveLoad: (() => void) | undefined;
    let calls = 0;
    const gate = { current: false };
    const loadMore = () => {
      calls += 1;
      return new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });
    };

    expect(runGuardedLoadMore(gate, loadMore)).toBe(true);
    expect(runGuardedLoadMore(gate, loadMore)).toBe(false);
    expect(calls).toBe(1);

    resolveLoad?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(gate.current).toBe(false);
    expect(runGuardedLoadMore(gate, loadMore)).toBe(true);
    expect(calls).toBe(2);
  });

  it("releases the gate when a load call throws synchronously", () => {
    const gate = { current: false };
    const error = new Error("load failed");

    expect(() => runGuardedLoadMore(gate, () => {
      throw error;
    })).toThrow(error);
    expect(gate.current).toBe(false);
  });

  it("releases the gate when an async load rejects", async () => {
    const gate = { current: false };

    expect(runGuardedLoadMore(gate, () => Promise.reject(new Error("load failed")))).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(gate.current).toBe(false);
  });
});

describe("shouldLoadMoreFromVirtualItems", () => {
  it("starts loading only near the end of the visible list", () => {
    expect(
      shouldLoadMoreFromVirtualItems({
        hasMore: true,
        isLoadingMore: false,
        itemCount: 20,
        lastVirtualIndex: 17,
        threshold: 3,
      }),
    ).toBe(true);

    expect(
      shouldLoadMoreFromVirtualItems({
        hasMore: true,
        isLoadingMore: false,
        itemCount: 20,
        lastVirtualIndex: 16,
        threshold: 3,
      }),
    ).toBe(false);
  });

  it("does not start loading when pagination is exhausted or already pending", () => {
    expect(
      shouldLoadMoreFromVirtualItems({
        hasMore: false,
        isLoadingMore: false,
        itemCount: 20,
        lastVirtualIndex: 19,
      }),
    ).toBe(false);

    expect(
      shouldLoadMoreFromVirtualItems({
        hasMore: true,
        isLoadingMore: true,
        itemCount: 20,
        lastVirtualIndex: 19,
      }),
    ).toBe(false);
  });
});

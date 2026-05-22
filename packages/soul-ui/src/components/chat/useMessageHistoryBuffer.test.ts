import { describe, expect, it } from "vitest";
import {
  MAX_ZERO_ADDED_DRAIN_PAGES,
  shouldDrainZeroAddedHistoryPage,
} from "./useMessageHistoryBuffer";

describe("shouldDrainZeroAddedHistoryPage", () => {
  it("continues when a page adds no rendered chat items but has an older cursor", () => {
    expect(
      shouldDrainZeroAddedHistoryPage({
        addedCount: 0,
        nextCursor: "cursor-2",
        previousCursor: "cursor-1",
        drainedPages: 0,
      }),
    ).toBe(true);
  });

  it("stops when a page added visible items", () => {
    expect(
      shouldDrainZeroAddedHistoryPage({
        addedCount: 1,
        nextCursor: "cursor-2",
        previousCursor: "cursor-1",
        drainedPages: 0,
      }),
    ).toBe(false);
  });

  it("stops at the beginning, repeated cursor, or safety cap", () => {
    expect(
      shouldDrainZeroAddedHistoryPage({
        addedCount: 0,
        nextCursor: null,
        previousCursor: "cursor-1",
        drainedPages: 0,
      }),
    ).toBe(false);
    expect(
      shouldDrainZeroAddedHistoryPage({
        addedCount: 0,
        nextCursor: "cursor-1",
        previousCursor: "cursor-1",
        drainedPages: 0,
      }),
    ).toBe(false);
    expect(
      shouldDrainZeroAddedHistoryPage({
        addedCount: 0,
        nextCursor: "cursor-2",
        previousCursor: "cursor-1",
        drainedPages: MAX_ZERO_ADDED_DRAIN_PAGES,
      }),
    ).toBe(false);
  });
});

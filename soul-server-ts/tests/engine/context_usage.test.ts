import { describe, expect, it } from "vitest";

import {
  contextUsagePercent,
  makeContextUsagePayload,
} from "../../src/engine/context_usage.js";

describe("context usage calculations", () => {
  it("calculates a one-decimal percentage and canonical wire payload", () => {
    expect(contextUsagePercent(418_042, 1_000_000)).toBe(41.8);
    expect(makeContextUsagePayload(418_042, 1_000_000)).toEqual({
      type: "context_usage",
      used_tokens: 418_042,
      max_tokens: 1_000_000,
      percent: 41.8,
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid usage or window value %s",
    (value) => {
      expect(contextUsagePercent(value, 100)).toBeUndefined();
      expect(contextUsagePercent(1, value)).toBeUndefined();
      expect(makeContextUsagePayload(value, 100)).toBeUndefined();
      expect(makeContextUsagePayload(1, value)).toBeUndefined();
    },
  );

  it.each(["1", null, undefined, {}])("rejects non-number values %s", (value) => {
    expect(makeContextUsagePayload(value, 100)).toBeUndefined();
    expect(makeContextUsagePayload(1, value)).toBeUndefined();
  });
});

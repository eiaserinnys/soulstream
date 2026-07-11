import { describe, expect, it } from "vitest";

import { isV2Pathname } from "./App";

describe("App v2 route boundary", () => {
  it("routes only /v2 and /v2 descendants to the additive shell", () => {
    expect(isV2Pathname("/v2")).toBe(true);
    expect(isV2Pathname("/v2/pages/page-1")).toBe(true);
    expect(isV2Pathname("/v2-other")).toBe(false);
    expect(isV2Pathname("/")).toBe(false);
    expect(isV2Pathname("/session-1")).toBe(false);
  });
});

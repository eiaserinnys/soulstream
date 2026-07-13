import { describe, expect, it } from "vitest";

import { isV3Pathname } from "../App";

describe("isV3Pathname", () => {
  it("matches only the /v3 route family", () => {
    expect(isV3Pathname("/v3")).toBe(true);
    expect(isV3Pathname("/v3/projects/project-1")).toBe(true);
    expect(isV3Pathname("/v3-other")).toBe(false);
    expect(isV3Pathname("/v2")).toBe(false);
    expect(isV3Pathname("/")).toBe(false);
  });
});

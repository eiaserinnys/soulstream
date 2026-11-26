import { describe, expect, it } from "vitest";

import { handoverReusesPort } from "../src/production.js";

describe("handoverReusesPort", () => {
  it("keeps the handover value on Linux", () => {
    expect(handoverReusesPort(true, "linux")).toBe(true);
    expect(handoverReusesPort(false, "linux")).toBe(false);
    expect(handoverReusesPort(undefined, "linux")).toBe(false);
  });

  it("never asks Windows for SO_REUSEPORT", () => {
    expect(handoverReusesPort(true, "win32")).toBe(false);
  });
});

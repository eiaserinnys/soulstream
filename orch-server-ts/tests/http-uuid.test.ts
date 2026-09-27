import { describe, expect, it } from "vitest";

import { isUuid } from "../src/http/uuid.js";

describe("shared UUID validation", () => {
  it("keeps shape-only and v4 validation as explicit policies", () => {
    const shapeOnly = "00000000-0000-0000-0000-000000000000";
    const version4 = "123e4567-e89b-42d3-a456-426614174000";

    expect(isUuid(shapeOnly)).toBe(true);
    expect(isUuid(shapeOnly, 4)).toBe(false);
    expect(isUuid(version4)).toBe(true);
    expect(isUuid(version4, 4)).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
  });

  it("supports RFC variant validation used by event ingress", () => {
    expect(isUuid("00000000-0000-0000-8000-000000000000", "rfc4122")).toBe(true);
    expect(isUuid("00000000-0000-0000-0000-000000000000", "rfc4122")).toBe(false);
  });
});

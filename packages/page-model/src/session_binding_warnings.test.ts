import { describe, expect, it } from "vitest";

import { projectSessionBindingWarnings } from "./session_binding_warnings.js";

describe("projectSessionBindingWarnings", () => {
  it.each([
    ["pending", "completed", ["PAGE_BINDING_PENDING"]],
    ["manual_repair", "completed", ["PAGE_BINDING_MANUAL_REPAIR"]],
    ["bound", "pending", ["LEGACY_PROJECTION_PENDING"]],
    ["bound", "manual_repair", ["LEGACY_PROJECTION_PENDING"]],
    ["bound", "completed", []],
    [null, null, []],
  ] as const)(
    "projects page=%s legacy=%s without a second warning source",
    (pageState, legacyState, expectedCodes) => {
      const warnings = projectSessionBindingWarnings({ pageState, legacyState });
      expect(warnings.map((warning) => warning.code)).toEqual(expectedCodes);
      expect(warnings.every((warning) => warning.message.length > 0)).toBe(true);
    },
  );

  it("describes manual legacy repair without promising an automatic retry", () => {
    expect(projectSessionBindingWarnings({
      pageState: "bound",
      legacyState: "manual_repair",
    })[0]?.message).toContain("Manual repair");
  });
});

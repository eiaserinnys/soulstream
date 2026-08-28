import { describe, expect, it } from "vitest";

import {
  applyLegacyGen0OwnerlessMutation,
  idealLegacyGen0OwnerlessMatrix,
  legacyGen0OwnerlessViolations,
  LEGACY_GEN0_MUTATION_EXPECTATIONS,
  type LegacyGen0OwnerlessMutation,
} from "./legacy_gen0_ownerless_zombie_oracle.js";

describe("legacy gen0 ownerless zombie mutation oracle", () => {
  it("detects skip-gen0, no-ownership-row exclusion, and status-only terminal writing", () => {
    const baseline = idealLegacyGen0OwnerlessMatrix();
    expect(legacyGen0OwnerlessViolations(baseline)).toEqual([]);

    const mutations = Object.keys(
      LEGACY_GEN0_MUTATION_EXPECTATIONS,
    ) as LegacyGen0OwnerlessMutation[];
    const result = Object.fromEntries(mutations.map((mutation) => {
      const expected = LEGACY_GEN0_MUTATION_EXPECTATIONS[mutation];
      const violations = legacyGen0OwnerlessViolations(
        applyLegacyGen0OwnerlessMutation(baseline, mutation),
      );
      expect(violations).toContain(expected);
      return [mutation, { expected, violations }];
    }));
    console.info("[legacy-gen0 ownerless mutation oracle]", JSON.stringify(result));
  });
});

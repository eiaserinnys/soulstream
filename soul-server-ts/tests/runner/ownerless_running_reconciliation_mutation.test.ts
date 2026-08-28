import { describe, expect, it } from "vitest";

import {
  applyOwnerlessMutation,
  idealOwnerlessMatrix,
  matrixViolations,
  OWNERLESS_MUTATION_EXPECTATIONS,
  type OwnerlessMutation,
} from "./ownerless_running_reconciliation_oracle.js";

describe("ownerless running reconciliation mutation oracle", () => {
  it("detects every required mutation in its named matrix row", () => {
    const baseline = idealOwnerlessMatrix();
    expect(matrixViolations(baseline)).toEqual({
      row1: [],
      row2: [],
      row3: [],
      row4: [],
      row5: [],
      row6: [],
    });

    const mutations = Object.keys(OWNERLESS_MUTATION_EXPECTATIONS) as OwnerlessMutation[];
    const result = Object.fromEntries(mutations.map((mutation) => {
      const expectation = OWNERLESS_MUTATION_EXPECTATIONS[mutation];
      const violations = matrixViolations(
        applyOwnerlessMutation(baseline, mutation),
      )[expectation.row];
      expect(violations).toContain(expectation.violation);
      return [mutation, { ...expectation, violations }];
    }));
    console.info("[ownerless-running mutation oracle]", JSON.stringify(result));
  });
});

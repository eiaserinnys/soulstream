import { describe, expect, it } from "vitest";

import {
  applyRetirementReproofMutation,
  idealRetirementReproofObservation,
  mutationViolationByName,
  retirementReproofViolations,
  type RetirementReproofMutation,
} from "./runner_retirement_reproof_oracle.js";

describe("runner retirement reproof mutation oracle", () => {
  it("independently detects all five forbidden regressions", () => {
    const mutations = Object.keys(mutationViolationByName) as RetirementReproofMutation[];
    const result = Object.fromEntries(mutations.map((mutation) => {
      const mutant = applyRetirementReproofMutation(
        idealRetirementReproofObservation(4),
        mutation,
      );
      return [mutation, retirementReproofViolations(mutant)];
    }));
    console.info("[retirement-reproof mutation oracle]", JSON.stringify(result));
    for (const mutation of mutations) {
      expect(result[mutation]).toContain(mutationViolationByName[mutation]);
    }
  });
});

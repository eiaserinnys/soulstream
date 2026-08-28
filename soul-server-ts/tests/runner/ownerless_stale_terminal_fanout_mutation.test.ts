import { describe, expect, it } from "vitest";

import {
  applyStaleTerminalFanoutMutation,
  idealStaleTerminalFanout,
  STALE_TERMINAL_MUTATION_EXPECTATIONS,
  staleTerminalFanoutViolations,
  type StaleTerminalFanoutMutation,
} from "./ownerless_stale_terminal_fanout_oracle.js";

describe("ownerless stale terminal semantic fanout mutation oracle", () => {
  it("detects all three forbidden fanout/status mutations", () => {
    const baseline = idealStaleTerminalFanout();
    expect(staleTerminalFanoutViolations(baseline)).toEqual([]);
    const mutations = Object.keys(
      STALE_TERMINAL_MUTATION_EXPECTATIONS,
    ) as StaleTerminalFanoutMutation[];
    const result = Object.fromEntries(mutations.map((mutation) => {
      const violation = STALE_TERMINAL_MUTATION_EXPECTATIONS[mutation];
      const violations = staleTerminalFanoutViolations(
        applyStaleTerminalFanoutMutation(baseline, mutation),
      );
      expect(violations).toContain(violation);
      return [mutation, { violation, violations }];
    }));
    console.info("[ownerless stale terminal mutation oracle]", JSON.stringify(result));
  });
});

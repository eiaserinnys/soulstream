import { describe, expect, it } from "vitest";

import { decideRunnerCentralCheck } from "../../src/runner/state/runner_central_check_decision.js";
import {
  RUNNER_ADOPT_RESPONSES,
  RUNNER_CENTRAL_LOOKUPS,
  type RunnerCentralCheckFacts,
} from "../../src/runner/state/runner_central_check_machine.js";

function check(facts: Partial<RunnerCentralCheckFacts>) {
  return decideRunnerCentralCheck({
    lookup: "inactive",
    terminalRetained: false,
    registrationAppliedAndTurnRunning: false,
    adoptResponse: "none",
    ...facts,
  });
}

describe("card #1266 U2a central check order", () => {
  it("never reaps a normally retained runner because of a no-retry adoption rejection", () => {
    for (const lookup of RUNNER_CENTRAL_LOOKUPS) {
      if (lookup === "missing" || lookup === "owner_node_changed") continue;
      for (const running of [false, true]) {
        expect(check({
          lookup,
          terminalRetained: true,
          registrationAppliedAndTurnRunning: running,
          adoptResponse: "terminal_rejection",
        }), `${lookup}/${running}`).toBe("keep");
      }
    }
  });

  it("still reaps a retained runner whose central session is gone or owned elsewhere", () => {
    for (const lookup of ["missing", "owner_node_changed"] as const) {
      expect(check({
        lookup,
        terminalRetained: true,
        adoptResponse: "terminal_rejection",
      })).toBe("reap");
    }
  });

  it("still reaps a runner that is not retained after a no-retry adoption rejection", () => {
    for (const lookup of RUNNER_CENTRAL_LOOKUPS) {
      expect(check({ lookup, adoptResponse: "terminal_rejection" })).toBe("reap");
    }
  });

  it("covers every response without leaving a retained runner reaped", () => {
    for (const lookup of RUNNER_CENTRAL_LOOKUPS) {
      for (const adoptResponse of RUNNER_ADOPT_RESPONSES) {
        const decision = check({ lookup, adoptResponse, terminalRetained: true });
        if (lookup !== "missing" && lookup !== "owner_node_changed") {
          expect(decision, `${lookup}/${adoptResponse}`).not.toBe("reap");
        }
      }
    }
  });
});

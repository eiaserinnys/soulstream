import { describe, expect, it } from "vitest";

import type { ExecutionSecurityDecision } from "../../src/security/session_isolation_contract.js";
import {
  desiredRunnerIsolation,
  fullRunnerIsolation,
  runnerIsolationAllowsReuse,
} from "../../src/security/session_isolation_turn.js";

function decision(tier: "full" | "restricted"): ExecutionSecurityDecision {
  return {
    sessionId: "sess-1",
    tier,
    policyVersion: 1,
    reason: tier === "restricted" ? "untrusted-preset" : "trusted",
    presetId: tier === "restricted" ? "deepseek-flash-4.1" : "claude-opus",
  };
}

describe("runner isolation identity", () => {
  it("treats full decisions as the default identity", () => {
    expect(desiredRunnerIsolation(decision("full"), "digest-1", ["wt-1"])).toEqual(
      fullRunnerIsolation(),
    );
    expect(desiredRunnerIsolation(null, "digest-1", [])).toEqual(fullRunnerIsolation());
  });

  it("records the digest and sorted attached worktrees for restricted turns", () => {
    expect(desiredRunnerIsolation(decision("restricted"), "digest-1", ["wt-b", "wt-a"]))
      .toEqual({
        tier: "restricted",
        policyDigest: "digest-1",
        attachedWorktreeIds: ["wt-a", "wt-b"],
      });
  });

  it("reuses a runner without identity only for full turns", () => {
    expect(runnerIsolationAllowsReuse(undefined, fullRunnerIsolation())).toBe(true);
    expect(runnerIsolationAllowsReuse(undefined, desiredRunnerIsolation(
      decision("restricted"),
      "digest-1",
      [],
    ))).toBe(false);
  });

  it("never reuses across tiers", () => {
    const restricted = desiredRunnerIsolation(decision("restricted"), "digest-1", []);
    expect(runnerIsolationAllowsReuse(restricted, fullRunnerIsolation())).toBe(false);
    expect(runnerIsolationAllowsReuse(fullRunnerIsolation(), restricted)).toBe(false);
  });

  it("reuses a restricted runner only with the same digest and attach set", () => {
    const existing = desiredRunnerIsolation(decision("restricted"), "digest-1", ["wt-a"]);
    expect(runnerIsolationAllowsReuse(
      existing,
      desiredRunnerIsolation(decision("restricted"), "digest-1", ["wt-a"]),
    )).toBe(true);
    expect(runnerIsolationAllowsReuse(
      existing,
      desiredRunnerIsolation(decision("restricted"), "digest-2", ["wt-a"]),
    )).toBe(false);
    expect(runnerIsolationAllowsReuse(
      existing,
      desiredRunnerIsolation(decision("restricted"), "digest-1", ["wt-a", "wt-b"]),
    )).toBe(false);
    expect(runnerIsolationAllowsReuse(
      existing,
      desiredRunnerIsolation(decision("restricted"), "digest-1", []),
    )).toBe(false);
  });
});

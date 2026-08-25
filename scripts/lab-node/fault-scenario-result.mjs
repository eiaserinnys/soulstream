import { randomUUID } from "node:crypto";

/** Refuses to call a run passed when it started from a red lab. */
export function withBaselineHonesty(result, baseline, invariant) {
  const stillPending = invariant?.unresolvedPending ?? [];
  if (stillPending.length > 0 && result.status === "passed") {
    return {
      ...result,
      status: "inconclusive_unresolved_pending",
      unresolvedPending: stillPending,
      reason: "the settle budget expired while sessions were still mid-answer",
    };
  }
  const dirty = baseline?.violations ?? [];
  if (dirty.length === 0 || result.status !== "passed") return result;
  return {
    ...result,
    status: "inconclusive_dirty_baseline",
    baselineViolations: dirty.map((violation) => ({
      invariant: violation.invariant,
      count: violation.count,
    })),
    reason: "the lab was already violating an invariant before this scenario ran",
  };
}

export function preflightRefusalReasons(preflight = {}) {
  return [
    ...(preflight.violations ?? []).map(
      (violation) => `invariant:${violation.invariant}`,
    ),
    ...(preflight.nonterminalSessions ?? []).map(
      (session) => `nonterminal_session:${session.session_id}:${session.status}`,
    ),
    ...(preflight.openOwnerships ?? []).map(
      (ownership) => `open_ownership:${ownership.session_id}:${ownership.ownership_generation}`,
    ),
    ...(preflight.runnerProcesses ?? []).map(
      (runner) => `runner_process:${runner.pid}`,
    ),
  ];
}

export function classifyHarnessStatus({
  fatalFailure,
  failureCount = 0,
  inconclusiveCount = 0,
} = {}) {
  if (fatalFailure) return "failed_harness_error";
  if (failureCount > 0) return "failed_new_violation";
  if (inconclusiveCount > 0) return "inconclusive";
  return "passed";
}

export function assertScenario(condition, message) {
  if (!condition) throw new Error(message);
}

export async function settle(promise) {
  try { return { status: "fulfilled", value: await promise }; } catch (error) {
    return { status: "rejected", reason: serializeError(error) };
  }
}

export function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function countLogLines(logs) {
  return { node: logs.node.length, orch: logs.orch.length };
}

export function shortId() {
  return randomUUID().slice(0, 8).toUpperCase();
}

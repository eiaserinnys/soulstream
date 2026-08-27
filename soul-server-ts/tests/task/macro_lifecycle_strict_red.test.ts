import { describe, expect, it } from "vitest";

import { observeCurrentProductSplitCommits } from
  "./macro_lifecycle_product_observer.js";

type DeliveryState = "none" | "pending" | "held" | "consumed";
type ProjectionPhase = "idle" | "initializing" | "running" | "terminal";
export type Outcome = "completed" | "retryable_failure" | "user_stopped" | "stop_failed";

export interface MacroTuple {
  delivery: {
    id: string | null;
    count: number;
    state: DeliveryState;
    ackCount: number;
    generation: number | null;
    callerSessionId: string | null;
    expectedCallerSessionId: string | null;
  };
  generation: { id: number; fenced: boolean; intent: boolean };
  owner: {
    count: number;
    generation: number | null;
    proven: boolean;
    live: boolean;
    compatible: boolean;
  };
  projection: {
    phase: ProjectionPhase;
    outcome: Outcome | null;
    reason: string | null;
    resetAt: string | null;
    workerTasks: number;
    executionPromises: number;
    automaticStarts: number;
    modelCalls: number;
    cancelCalls: number;
    reattachCalls: number;
    spawnCalls: number;
  };
}

export type LifecycleEvent =
  | { type: "accept"; deliveryId: string; callerSessionId?: string }
  | { type: "new_input_intent" }
  | { type: "reserve" }
  | { type: "prove"; live?: boolean; compatible?: boolean }
  | { type: "activate" }
  | { type: "complete" }
  | { type: "retryable_failure"; reason: string; resetAt?: string }
  | { type: "quota_allowed" }
  | { type: "late_completion" | "late_intervention" | "late_notification" }
  | { type: "cooldown_tick" }
  | { type: "user_stop"; runnerConfirmed?: boolean }
  | { type: "explicit_resume"; compatibleRunner: boolean };

type Mutation =
  | "prove_gate_removed"
  | "terminal_reopen_allowed"
  | "owner_release_removed"
  | "failure_early_ack"
  | "cooldown_auto_retry"
  | "stop_fence_removed"
  | "late_completion_overwrite"
  | "unconsumed_delivery_purged"
  | "worker_cleanup_omitted";

interface ContractCase {
  name: string;
  events: LifecycleEvent[];
  expectedGeneration: number;
}

const RESET_FIVE_HOUR = "2026-08-26T20:10:00.000Z";
const RESET_SEVEN_DAY = "2026-08-30T22:00:00.000Z";
const PARENT = "5f4d5bc1-ad00-402e-962e-ba9e0314e5d4";

const CASES: ContractCase[] = [
  {
    name: "32b3 completion delivery survives unproven reserve/fail and late backfill",
    events: [accept("d-32", PARENT), { type: "reserve" }, { type: "activate" },
      failure("runner_unavailable"), { type: "late_notification" },
      { type: "late_intervention" }, { type: "cooldown_tick" }],
    expectedGeneration: 0,
  },
  {
    name: "039 terminal generation absorbs ENOENT-era late intervention",
    events: successTurn("d-039").concat(
      { type: "late_intervention" }, { type: "late_completion" }),
    expectedGeneration: 1,
  },
  {
    name: "b1 ownership conflict leaves one pending input and no owner",
    events: [accept("d-b1"), { type: "new_input_intent" }, { type: "reserve" },
      { type: "activate" },
      failure("runner_schema_mismatch"), { type: "late_intervention" },
      { type: "cooldown_tick" }],
    expectedGeneration: 1,
  },
  {
    name: "c57 caller provenance remains an ordinary accepted-input field",
    events: [accept("d-c57", PARENT), { type: "new_input_intent" },
      { type: "reserve" }, { type: "activate" }, failure("creation_boundary_failure")],
    expectedGeneration: 1,
  },
  {
    name: "v9 retained file is not an unacknowledged event delivery",
    events: [accept("d-v9"), failure("closed_tail_pending_intervention")],
    expectedGeneration: 0,
  },
  {
    name: "e941 five_hour rejected terminalizes without cooldown work",
    events: activeTurn("d-five").concat(
      failure("quota_rejected", RESET_FIVE_HOUR), { type: "cooldown_tick" },
      { type: "late_completion" }, { type: "late_notification" }),
    expectedGeneration: 1,
  },
  {
    name: "e941 seven_day_overage_included shares the quota failure transition",
    events: activeTurn("d-seven").concat(
      failure("quota_rejected", RESET_SEVEN_DAY), { type: "cooldown_tick" },
      { type: "late_completion" }, { type: "late_intervention" }),
    expectedGeneration: 1,
  },
  {
    name: "38ab allowed credential alert remains a successful positive oracle",
    events: activeTurn("d-allowed").concat({ type: "quota_allowed" }, { type: "complete" }),
    expectedGeneration: 1,
  },
  {
    name: "user_stop fences an active generation and holds unconsumed input",
    events: activeTurn("d-stop").concat(
      { type: "user_stop", runnerConfirmed: true }, { type: "late_completion" },
      { type: "late_intervention" }, { type: "user_stop", runnerConfirmed: true }),
    expectedGeneration: 1,
  },
  {
    name: "user_stop transport failure still fences and exposes stop_failed",
    events: activeTurn("d-stop-fail").concat(
      { type: "user_stop", runnerConfirmed: false }, { type: "late_completion" },
      { type: "late_notification" }, { type: "cooldown_tick" }),
    expectedGeneration: 1,
  },
  {
    name: "explicit resume creates one new generation and reattaches a compatible runner",
    events: activeTurn("d-resume").concat(
      { type: "user_stop", runnerConfirmed: true },
      { type: "explicit_resume", compatibleRunner: true }, { type: "prove" },
      { type: "activate" }, { type: "complete" }),
    expectedGeneration: 2,
  },
];

describe("macro lifecycle split-commit strict RED", () => {
  it.each(CASES)("reference contract: $name", ({ events, expectedGeneration }) => {
    const trace = run(events);
    expect(traceViolations(trace)).toEqual([]);
    expect(trace.at(-1)?.generation.id).toBe(expectedGeneration);
  });

  it("each inverse mutation breaks at least two counterexamples", () => {
    const coverage = Object.fromEntries(MUTATIONS.map((mutation) => [
      mutation,
      CASES.filter(({ events }) => traceViolations(run(events, mutation)).length > 0)
        .map(({ name }) => name),
    ]));
    console.info("MACRO_LIFECYCLE_MUTATION_COVERAGE", JSON.stringify(coverage, null, 2));
    for (const mutation of MUTATIONS) {
      expect(coverage[mutation].length, mutation).toBeGreaterThanOrEqual(2);
    }
  });

  it("current product transitions conform to the same tuple", async () => {
    const observations = await observeCurrentProductSplitCommits({
      run, activeTurn, successTurn, accept,
      parentSessionId: PARENT,
    });
    const violations = observations.flatMap(({ name, state }) =>
      stateViolations(state).map((violation) => `${name}: ${violation}`));
    console.info("MACRO_LIFECYCLE_STRICT_RED", JSON.stringify({ observations, violations }, null, 2));
    expect(violations).toEqual([]);
  });
});

const MUTATIONS: Mutation[] = [
  "prove_gate_removed", "terminal_reopen_allowed", "owner_release_removed",
  "failure_early_ack", "cooldown_auto_retry", "stop_fence_removed",
  "late_completion_overwrite", "unconsumed_delivery_purged",
  "worker_cleanup_omitted",
];

function initial(): MacroTuple {
  return {
    delivery: { id: null, count: 0, state: "none", ackCount: 0, generation: null,
      callerSessionId: null, expectedCallerSessionId: null },
    generation: { id: 0, fenced: false, intent: false },
    owner: { count: 0, generation: null, proven: false, live: false, compatible: false },
    projection: { phase: "idle", outcome: null, reason: null, resetAt: null,
      workerTasks: 0, executionPromises: 0, automaticStarts: 0, modelCalls: 0,
      cancelCalls: 0, reattachCalls: 0, spawnCalls: 0 },
  };
}

function run(events: LifecycleEvent[], mutation?: Mutation): MacroTuple[] {
  const trace = [initial()];
  for (const event of events) trace.push(transition(trace.at(-1)!, event, mutation));
  return trace;
}

function transition(previous: MacroTuple, event: LifecycleEvent, mutation?: Mutation): MacroTuple {
  const next = structuredClone(previous);
  if (event.type === "accept") {
    if (next.delivery.id === null || next.delivery.state === "consumed") {
      next.delivery = { id: event.deliveryId, count: 1, state: "pending", ackCount: 0,
        generation: null,
        callerSessionId: event.callerSessionId ?? null,
        expectedCallerSessionId: event.callerSessionId ?? null };
    }
  } else if (event.type === "new_input_intent") {
    beginGenerationIntent(next);
  } else if (event.type === "reserve") {
    if (next.generation.intent && !next.generation.fenced) {
      next.projection.phase = "initializing";
    }
  } else if (event.type === "prove") {
    next.owner.proven = true;
    next.owner.live = event.live ?? true;
    next.owner.compatible = event.compatible ?? true;
  } else if (event.type === "activate") {
    if (next.generation.intent && !next.generation.fenced
        && (next.owner.proven || mutation === "prove_gate_removed")) {
      next.owner = { ...next.owner, count: 1, generation: next.generation.id,
        live: true, compatible: true };
      next.projection.phase = "running";
      next.projection.workerTasks = 1;
      next.projection.executionPromises = 1;
    }
  } else if (event.type === "complete") {
    finalize(next, "completed", mutation);
  } else if (event.type === "retryable_failure") {
    if (next.generation.intent || next.projection.phase === "running") {
      finalize(next, "retryable_failure", mutation, event.reason, event.resetAt ?? null);
    }
  } else if (event.type === "user_stop") {
    if (next.projection.cancelCalls === 0) next.projection.cancelCalls = 1;
    if (mutation !== "stop_fence_removed") next.generation.fenced = true;
    finalize(next, event.runnerConfirmed === false ? "stop_failed" : "user_stopped", mutation,
      event.runnerConfirmed === false ? "runner_stop_unconfirmed" : "user_stop");
    if (next.delivery.state === "pending") next.delivery.state = "held";
    if (mutation === "unconsumed_delivery_purged") {
      next.delivery.state = "consumed";
      next.delivery.ackCount = 1;
    }
  } else if (event.type === "late_completion" || event.type === "late_intervention"
      || event.type === "late_notification") {
    if (next.projection.phase === "terminal" && mutation === "terminal_reopen_allowed") {
      next.projection.phase = "initializing";
      next.projection.outcome = null;
      next.generation.intent = true;
      next.generation.fenced = false;
      next.projection.automaticStarts += 1;
    }
    if (event.type === "late_completion" && mutation === "late_completion_overwrite") {
      next.projection.phase = "terminal";
      next.projection.outcome = "completed";
      next.delivery.state = "consumed";
      next.delivery.ackCount = 1;
    }
  } else if (event.type === "cooldown_tick") {
    if (next.projection.resetAt && mutation === "cooldown_auto_retry") {
      next.projection.phase = "initializing";
      next.projection.automaticStarts += 1;
      next.projection.modelCalls += 1;
    }
  } else if (event.type === "explicit_resume") {
    if (next.projection.phase === "terminal") {
      beginGenerationIntent(next);
      next.owner = { count: 0, generation: null, proven: false, live: false, compatible: false };
      next.projection.cancelCalls = 0;
      if (event.compatibleRunner) next.projection.reattachCalls += 1;
      else next.projection.spawnCalls += 1;
      if (next.delivery.state === "held") next.delivery.state = "pending";
    }
  }
  return next;
}

function finalize(
  state: MacroTuple,
  outcome: Outcome,
  mutation?: Mutation,
  reason: string | null = null,
  resetAt: string | null = null,
): void {
  state.projection.phase = "terminal";
  state.projection.outcome = outcome;
  state.projection.reason = reason;
  state.projection.resetAt = resetAt;
  state.generation.intent = false;
  if (mutation !== "stop_fence_removed"
      || (outcome !== "user_stopped" && outcome !== "stop_failed")) {
    state.generation.fenced = true;
  }
  if (mutation !== "owner_release_removed") {
    state.owner.count = 0;
    state.owner.generation = null;
  }
  if (mutation !== "worker_cleanup_omitted") {
    state.projection.workerTasks = 0;
    state.projection.executionPromises = 0;
  }
  if ((outcome === "completed" && state.delivery.generation === state.generation.id)
      || mutation === "failure_early_ack") {
    state.delivery.state = "consumed";
    state.delivery.ackCount = 1;
  }
}

function beginGenerationIntent(state: MacroTuple): void {
  state.generation.id += 1;
  state.generation.fenced = false;
  state.generation.intent = true;
  state.projection.phase = "idle";
  state.projection.outcome = null;
  state.projection.reason = null;
  state.projection.resetAt = null;
  if (state.delivery.state === "pending" || state.delivery.state === "held") {
    state.delivery.generation = state.generation.id;
  }
}

function traceViolations(trace: MacroTuple[]): string[] {
  const violations = trace.flatMap(stateViolations);
  for (let index = 1; index < trace.length; index += 1) {
    const previous = trace[index - 1]!;
    const current = trace[index]!;
    if (
      previous.projection.phase === "terminal"
      && current.generation.id === previous.generation.id
      && (
        current.projection.phase !== "terminal"
        || current.projection.outcome !== previous.projection.outcome
      )
    ) violations.push("terminal generation was reopened or overwritten by a late event");
  }
  return [...new Set(violations)];
}

function stateViolations(state: MacroTuple): string[] {
  const violations: string[] = [];
  if (state.delivery.count > 1) violations.push("accepted input was recorded more than once");
  if (state.delivery.expectedCallerSessionId !== state.delivery.callerSessionId) {
    violations.push("caller provenance was not preserved on the accepted input");
  }
  if (state.owner.count < 0 || state.owner.count > 1) violations.push("owner cardinality exceeded 0..1");
  if (state.projection.phase === "running" && !(
    state.owner.count === 1 && state.owner.generation === state.generation.id
    && state.owner.proven && state.owner.live && state.owner.compatible
    && state.generation.intent
    && state.projection.workerTasks === 1 && state.projection.executionPromises === 1
  )) violations.push(
    "running was projected without explicit intent + prove + same-generation owner + worker",
  );
  if (state.projection.phase === "terminal" && !state.generation.fenced) {
    violations.push("terminal generation was not fenced");
  }
  if (state.projection.phase === "terminal" && state.generation.intent) {
    violations.push("terminal generation retained execution intent");
  }
  if (state.projection.phase === "terminal" && state.owner.count !== 0) {
    violations.push("terminal generation retained an execution owner");
  }
  if (state.projection.phase === "terminal"
      && (state.projection.workerTasks !== 0 || state.projection.executionPromises !== 0)) {
    violations.push("terminal generation retained worker execution state");
  }
  const deliveryBelongsToGeneration = state.delivery.generation === state.generation.id;
  if (state.delivery.state === "consumed" && !deliveryBelongsToGeneration) {
    violations.push("delivery was consumed by an unrelated generation");
  }
  if (state.projection.outcome === "completed" && deliveryBelongsToGeneration) {
    if (state.delivery.state !== "consumed" || state.delivery.ackCount !== 1) {
      violations.push("successful finalization did not consume and ACK exactly once");
    }
  } else if (state.projection.outcome !== "completed"
      && (state.delivery.state === "consumed" || state.delivery.ackCount !== 0)) {
    violations.push("non-success path consumed or ACKed the delivery");
  }
  if (state.projection.automaticStarts !== 0 || state.projection.modelCalls !== 0) {
    violations.push("work started without explicit resume or new input");
  }
  if ((state.projection.outcome === "user_stopped" || state.projection.outcome === "stop_failed")
      && state.delivery.state !== "held" && state.delivery.state !== "pending") {
    violations.push("user_stop did not preserve accepted-but-unconsumed delivery");
  }
  if (state.projection.cancelCalls > 0 && state.projection.phase !== "terminal") {
    violations.push("user_stop returned before durable terminal convergence");
  }
  if (state.projection.cancelCalls > 1) violations.push("user_stop cancelled more than once");
  return violations;
}

export function accept(deliveryId: string, callerSessionId?: string): LifecycleEvent {
  return { type: "accept", deliveryId, ...(callerSessionId ? { callerSessionId } : {}) };
}

export function activeTurn(deliveryId: string): LifecycleEvent[] {
  return [accept(deliveryId), { type: "new_input_intent" }, { type: "reserve" },
    { type: "prove" }, { type: "activate" }];
}

export function successTurn(deliveryId: string): LifecycleEvent[] {
  return activeTurn(deliveryId).concat({ type: "complete" });
}

function failure(reason: string, resetAt?: string): LifecycleEvent {
  return { type: "retryable_failure", reason, ...(resetAt ? { resetAt } : {}) };
}

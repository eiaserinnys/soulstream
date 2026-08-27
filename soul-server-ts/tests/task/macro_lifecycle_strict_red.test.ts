import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import { resolveStructuralCallerSessionId } from
  "../../src/task/delegation_relationship.js";
import { TaskDeliveryLedgerGate } from
  "../../src/task/task_delivery_ledger_gate.js";
import { TaskInterventionRoute } from
  "../../src/task/task_intervention_route.js";
import { TaskLifecycleTransition } from
  "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";
import { TaskRunnerRecovery } from
  "../../src/task/task_runner_recovery.js";

type DeliveryState = "none" | "pending" | "held" | "consumed";
type ProjectionPhase = "idle" | "initializing" | "running" | "terminal";
type Outcome = "completed" | "retryable_failure" | "user_stopped" | "stop_failed";

interface MacroTuple {
  delivery: {
    id: string | null;
    count: number;
    state: DeliveryState;
    ackCount: number;
    callerSessionId: string | null;
    expectedCallerSessionId: string | null;
  };
  generation: { id: number; fenced: boolean };
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

type LifecycleEvent =
  | { type: "accept"; deliveryId: string; callerSessionId?: string }
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
  },
  {
    name: "039 terminal generation absorbs ENOENT-era late intervention",
    events: successTurn("d-039").concat(
      { type: "late_intervention" }, { type: "late_completion" }),
  },
  {
    name: "b1 ownership conflict leaves one pending input and no owner",
    events: [accept("d-b1"), { type: "reserve" }, { type: "activate" },
      failure("runner_schema_mismatch"), { type: "late_intervention" },
      { type: "cooldown_tick" }],
  },
  {
    name: "c57 caller provenance remains an ordinary accepted-input field",
    events: [accept("d-c57", PARENT), failure("creation_boundary_failure")],
  },
  {
    name: "v9 retained file is not an unacknowledged event delivery",
    events: [accept("d-v9"), failure("closed_tail_pending_intervention")],
  },
  {
    name: "e941 five_hour rejected terminalizes without cooldown work",
    events: activeTurn("d-five").concat(
      failure("quota_rejected", RESET_FIVE_HOUR), { type: "cooldown_tick" },
      { type: "late_completion" }, { type: "late_notification" }),
  },
  {
    name: "e941 seven_day_overage_included shares the quota failure transition",
    events: activeTurn("d-seven").concat(
      failure("quota_rejected", RESET_SEVEN_DAY), { type: "cooldown_tick" },
      { type: "late_completion" }, { type: "late_intervention" }),
  },
  {
    name: "38ab allowed credential alert remains a successful positive oracle",
    events: activeTurn("d-allowed").concat({ type: "quota_allowed" }, { type: "complete" }),
  },
  {
    name: "user_stop fences an active generation and holds unconsumed input",
    events: activeTurn("d-stop").concat(
      { type: "user_stop", runnerConfirmed: true }, { type: "late_completion" },
      { type: "late_intervention" }, { type: "user_stop", runnerConfirmed: true }),
  },
  {
    name: "user_stop transport failure still fences and exposes stop_failed",
    events: activeTurn("d-stop-fail").concat(
      { type: "user_stop", runnerConfirmed: false }, { type: "late_completion" },
      { type: "late_notification" }, { type: "cooldown_tick" }),
  },
  {
    name: "explicit resume creates one new generation and reattaches a compatible runner",
    events: activeTurn("d-resume").concat(
      { type: "user_stop", runnerConfirmed: true },
      { type: "explicit_resume", compatibleRunner: true }, { type: "prove" },
      { type: "activate" }, { type: "complete" }),
  },
];

describe("macro lifecycle split-commit strict RED", () => {
  it.each(CASES)("reference contract: $name", ({ events }) => {
    const trace = run(events);
    expect(traceViolations(trace)).toEqual([]);
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
    const observations = await observeCurrentProductSplitCommits();
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
    delivery: { id: null, count: 0, state: "none", ackCount: 0,
      callerSessionId: null, expectedCallerSessionId: null },
    generation: { id: 0, fenced: false },
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
    if (next.delivery.id === null) {
      next.delivery = { id: event.deliveryId, count: 1, state: "pending", ackCount: 0,
        callerSessionId: event.callerSessionId ?? null,
        expectedCallerSessionId: event.callerSessionId ?? null };
      next.generation.id += 1;
    }
  } else if (event.type === "reserve") {
    if (!next.generation.fenced) next.projection.phase = "initializing";
  } else if (event.type === "prove") {
    next.owner.proven = true;
    next.owner.live = event.live ?? true;
    next.owner.compatible = event.compatible ?? true;
  } else if (event.type === "activate") {
    if (!next.generation.fenced && (next.owner.proven || mutation === "prove_gate_removed")) {
      next.owner = { ...next.owner, count: 1, generation: next.generation.id,
        live: true, compatible: true };
      next.projection.phase = "running";
      next.projection.workerTasks = 1;
      next.projection.executionPromises = 1;
    }
  } else if (event.type === "complete") {
    finalize(next, "completed", mutation);
  } else if (event.type === "retryable_failure") {
    finalize(next, "retryable_failure", mutation, event.reason, event.resetAt ?? null);
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
    if (!next.generation.fenced || mutation === "terminal_reopen_allowed") {
      next.projection.phase = "initializing";
      next.projection.outcome = null;
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
      next.generation.id += 1;
      next.generation.fenced = false;
      next.owner = { count: 0, generation: null, proven: false, live: false, compatible: false };
      next.projection.phase = "initializing";
      next.projection.outcome = null;
      next.projection.reason = null;
      next.projection.resetAt = null;
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
  if (outcome === "completed" || mutation === "failure_early_ack") {
    state.delivery.state = "consumed";
    state.delivery.ackCount = 1;
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
    && state.projection.workerTasks === 1 && state.projection.executionPromises === 1
  )) violations.push("running was projected without prove + same-generation owner + worker");
  if (state.projection.phase === "terminal" && !state.generation.fenced) {
    violations.push("terminal generation was not fenced");
  }
  if (state.projection.phase === "terminal" && state.owner.count !== 0) {
    violations.push("terminal generation retained an execution owner");
  }
  if (state.projection.phase === "terminal"
      && (state.projection.workerTasks !== 0 || state.projection.executionPromises !== 0)) {
    violations.push("terminal generation retained worker execution state");
  }
  if (state.projection.outcome === "completed") {
    if (state.delivery.state !== "consumed" || state.delivery.ackCount !== 1) {
      violations.push("successful finalization did not consume and ACK exactly once");
    }
  } else if (state.delivery.state === "consumed" || state.delivery.ackCount !== 0) {
    violations.push("non-success path consumed or ACKed the delivery");
  }
  if (state.projection.automaticStarts !== 0 || state.projection.modelCalls !== 0) {
    violations.push("work started without explicit resume or new input");
  }
  if ((state.projection.outcome === "user_stopped" || state.projection.outcome === "stop_failed")
      && state.delivery.state !== "held") {
    violations.push("user_stop did not hold accepted-but-unconsumed delivery");
  }
  if (state.projection.cancelCalls > 0 && state.projection.phase !== "terminal") {
    violations.push("user_stop returned before durable terminal convergence");
  }
  if (state.projection.cancelCalls > 1) violations.push("user_stop cancelled more than once");
  return violations;
}

async function observeCurrentProductSplitCommits(): Promise<Array<{ name: string; state: MacroTuple }>> {
  return [
    await observeCurrentStop(),
    await observeCurrentRecovery(),
    await observeCurrentLateIntervention(),
    await observeCurrentEarlyConsume(),
    observeCurrentCallerProvenance(),
  ];
}

async function observeCurrentStop(): Promise<{ name: string; state: MacroTuple }> {
  const state = run(activeTurn("product-stop")).at(-1)!;
  const task = productTask({
    executionPromise: Promise.resolve(),
    executionOwnership: productOwner(),
    runner: { engine: {} as never, dispatcher: { interrupt: vi.fn(async () => true) } as never },
  });
  const transition = new TaskLifecycleTransition({ logger: pino({ level: "silent" }) });
  await transition.cancelRunningTask(task);
  state.projection.cancelCalls = 1;
  state.generation.fenced = false;
  state.owner.count = task.executionOwnership ? 1 : 0;
  state.projection.workerTasks = task.runner ? 1 : 0;
  state.projection.executionPromises = task.executionPromise ? 1 : 0;
  state.projection.phase = "running";
  return { name: "current user_stop ACK", state };
}

async function observeCurrentRecovery(): Promise<{ name: string; state: MacroTuple }> {
  const state = run([accept("product-recovery"), { type: "reserve" }]).at(-1)!;
  const task = productTask();
  let resumeCalls = 0;
  const recovery = new TaskRunnerRecovery({
    getTask: vi.fn(), loadTask: vi.fn(), rememberTask: vi.fn(),
    lifecycleTransition: { persistExecutorFinalState: vi.fn(async () => ({
      newlyFinalized: true, terminalTransitionApplied: true,
    })) } as never,
    autoResumeTransition: { resume: vi.fn(async (resumed: Task, _message, callback) => {
      resumeCalls += 1;
      resumed.status = "initializing";
      callback(resumed);
      return { autoResumed: true as const };
    }) } as never,
  });
  await recovery.markFailureAndResume(task, "runner unavailable", vi.fn());
  state.projection.phase = task.status === "initializing" ? "initializing" : "terminal";
  state.projection.automaticStarts = resumeCalls;
  return { name: "current runner failure recovery", state };
}

async function observeCurrentLateIntervention(): Promise<{ name: string; state: MacroTuple }> {
  const state = run(successTurn("product-late")).at(-1)!;
  const task = productTask({ status: "completed", terminationReason: "completed_ok" });
  let resumeCalls = 0;
  const route = new TaskInterventionRoute({
    getTask: () => task, loadEvictedTask: vi.fn(), rememberTask: vi.fn(),
    runningInterventionTransition: {} as never,
    autoResumeTransition: { resume: vi.fn(async () => {
      resumeCalls += 1;
      return { autoResumed: true as const };
    }) },
  });
  await route.addIntervention({ agentSessionId: task.agentSessionId, text: "late", user: "system",
    source: "completion_notifier" }, vi.fn());
  state.projection.phase = "initializing";
  state.projection.outcome = null;
  state.projection.automaticStarts = resumeCalls;
  return { name: "current terminal intervention", state };
}

async function observeCurrentEarlyConsume(): Promise<{ name: string; state: MacroTuple }> {
  const state = run(activeTurn("product-delivery")).at(-1)!;
  const markConsumed = vi.fn(async () => ({ state: "consumed" }));
  const gate = new TaskDeliveryLedgerGate(true, {
    register: vi.fn(), claimForTarget: vi.fn(), beginDispatch: vi.fn(), get: vi.fn(),
    markQueued: vi.fn(), markDelivered: vi.fn(async () => ({ state: "delivered" })),
    markUncertain: vi.fn(), markConsumed, markConsumedByRelation: vi.fn(),
    recordRelationConsumed: vi.fn(), retryLeasedDelivery: vi.fn(), markPendingSuperseded: vi.fn(),
    notifications: { stageWithQueuedDelivery: vi.fn(), get: vi.fn(), markPublished: vi.fn(), retry: vi.fn() },
  } as never);
  await gate.recordResult({ kind: "admitted", deliveryId: "product-delivery", row: {
    delivery_id: "product-delivery", intent: "human_live_steer", lease_owner: "lease",
  } as SessionDeliveryRow }, { delivered: true });
  if (markConsumed.mock.calls.length > 0) {
    state.delivery.state = "consumed";
    state.delivery.ackCount = 1;
  }
  return { name: "current live intervention receipt", state };
}

function observeCurrentCallerProvenance(): { name: string; state: MacroTuple } {
  const state = run([accept("product-caller", PARENT)]).at(-1)!;
  state.delivery.callerSessionId = resolveStructuralCallerSessionId(PARENT, false);
  return { name: "current notify_completion=false creation", state };
}

function productTask(overrides: Partial<Task> = {}): Task {
  return { agentSessionId: "product-session", prompt: "input", status: "running",
    createdAt: new Date("2026-08-27T00:00:00.000Z"), lastEventId: 1,
    lastReadEventId: 0, interventionQueue: [], ...overrides };
}

function productOwner(): NonNullable<Task["executionOwnership"]> {
  return { ownerKind: "spawned_runner", manifestId: "sha", runtimeEnvIdentity: "env",
    ownershipGeneration: 1, registrationId: "registration", pid: 42,
    startIdentity: "start", executionCommandId: "execute" };
}

function accept(deliveryId: string, callerSessionId?: string): LifecycleEvent {
  return { type: "accept", deliveryId, ...(callerSessionId ? { callerSessionId } : {}) };
}

function activeTurn(deliveryId: string): LifecycleEvent[] {
  return [accept(deliveryId), { type: "reserve" }, { type: "prove" }, { type: "activate" }];
}

function successTurn(deliveryId: string): LifecycleEvent[] {
  return activeTurn(deliveryId).concat({ type: "complete" });
}

function failure(reason: string, resetAt?: string): LifecycleEvent {
  return { type: "retryable_failure", reason, ...(resetAt ? { resetAt } : {}) };
}

import pino from "pino";
import { vi } from "vitest";

import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import { resolveStructuralCallerSessionId } from
  "../../src/task/delegation_relationship.js";
import { TaskDeliveryLedgerGate } from
  "../../src/task/task_delivery_ledger_gate.js";
import { TaskInterventionRoute } from
  "../../src/task/task_intervention_route.js";
import { TaskLifecycleTransition } from
  "../../src/task/task_lifecycle_transition.js";
import type { ExecutionActivation, Task } from "../../src/task/task_models.js";
import { TaskRunnerRecovery } from
  "../../src/task/task_runner_recovery.js";
import type { LifecycleEvent, MacroTuple, Outcome } from
  "./macro_lifecycle_strict_red.test.js";

interface ContractHarness {
  run(events: LifecycleEvent[]): MacroTuple[];
  activeTurn(deliveryId: string): LifecycleEvent[];
  successTurn(deliveryId: string): LifecycleEvent[];
  accept(deliveryId: string, callerSessionId?: string): LifecycleEvent;
  parentSessionId: string;
}

export async function observeCurrentProductSplitCommits(
  harness: ContractHarness,
): Promise<Array<{ name: string; state: MacroTuple }>> {
  return [
    await observeCurrentStop(harness, true),
    await observeCurrentStop(harness, false),
    await observeCurrentRecovery(harness),
    await observeCurrentLateIntervention(harness),
    await observeCurrentEarlyConsume(harness),
    observeCurrentCallerProvenance(harness),
  ];
}

async function observeCurrentStop(h: ContractHarness, runnerConfirmed: boolean) {
  const state = h.run(h.activeTurn(`product-stop-${runnerConfirmed}`)).at(-1)!;
  const interrupt = vi.fn(async () => runnerConfirmed);
  const task = productTask({ executionPromise: Promise.resolve(),
    executionOwnership: productOwner(), runner: { engine: {} as never, dispatcher: {
      interrupt, close: vi.fn(),
      hasActiveExecution: () => true } as never } });
  const release = vi.fn(async () => terminalApplication(task));
  const noOwnerTerminal = vi.fn(async () => terminalApplication(task));
  const transition = new TaskLifecycleTransition({ logger: pino({ level: "silent" }),
    persistence: { releaseExecutionOwnershipAndWaitForApplication: release,
      enqueueTerminalTransitionAndWaitForApplication: noOwnerTerminal } as never });
  const cancelled = await transition.cancelRunningTask(task);
  const fenced = release.mock.calls.length + noOwnerTerminal.mock.calls.length === 1;
  state.projection.cancelCalls = interrupt.mock.calls.length;
  state.generation.fenced = fenced;
  state.generation.intent = !fenced;
  applyObservedTask(state, task, cancelled ? "user_stopped" : "stop_failed");
  return { name: `current user_stop ${runnerConfirmed ? "ACK" : "failed confirmation"}`, state };
}

async function observeCurrentRecovery(h: ContractHarness) {
  const state = h.run(h.activeTurn("product-recovery")).at(-1)!;
  const task = productTask();
  const persist = vi.fn(async () => ({ newlyFinalized: true, terminalTransitionApplied: true }));
  const autoResume = new AutoResumeTransition({ logger: pino({ level: "silent" }),
    persistence: { acquireExecutionOwnershipAndWaitForApplication: vi.fn() } as never });
  const start = vi.fn((resumed: Task, activation?: ExecutionActivation) => {
    observeAutomaticGeneration(state);
    startObservedExecution(resumed, activation, state.generation.id);
  });
  const recovery = new TaskRunnerRecovery({ getTask: vi.fn(), loadTask: vi.fn(),
    rememberTask: vi.fn(), lifecycleTransition: { persistExecutorFinalState: persist } as never,
    autoResumeTransition: autoResume });
  await recovery.markFailureAndResume(task, "runner unavailable", start);
  if (start.mock.calls.length === 0) {
    state.generation.fenced = persist.mock.calls.length === 1;
    state.generation.intent = !state.generation.fenced;
  }
  state.projection.automaticStarts = start.mock.calls.length;
  applyObservedTask(state, task, "retryable_failure");
  return { name: "current runner failure recovery", state };
}

async function observeCurrentLateIntervention(h: ContractHarness) {
  const deliveryId = "product-late-notification";
  const events = h.successTurn("product-previous").concat(h.accept(deliveryId));
  const state = h.run(events).at(-1)!;
  const task = productTask({ status: "completed", terminationReason: "completed_ok",
    terminalEventId: 1 });
  let row = productDelivery(deliveryId);
  const markConsumed = vi.fn();
  const repository = { get: vi.fn(async () => row), register: vi.fn(),
    claimForTarget: vi.fn(async (_id, target, lease) => (row = { ...row, state: "claimed",
      target_session_id: target, lease_owner: lease })),
    beginDispatch: vi.fn(async () => (row = { ...row, state: "dispatching" })),
    markQueued: vi.fn(), markDelivered: vi.fn(), markUncertain: vi.fn(), markConsumed,
    markConsumedByRelation: vi.fn(), recordRelationConsumed: vi.fn(),
    retryLeasedDelivery: vi.fn(), markPendingSuperseded: vi.fn(),
    notifications: { stageWithQueuedDelivery: vi.fn(async () => ({ state: "queued" })),
      get: vi.fn(), markPublished: vi.fn(), retry: vi.fn() } };
  const gate = new TaskDeliveryLedgerGate(true, repository as never);
  const autoResume = new AutoResumeTransition({ logger: pino({ level: "silent" }),
    persistence: { acquireExecutionOwnershipAndWaitForApplication: vi.fn() } as never });
  const start = vi.fn((resumed: Task, activation?: ExecutionActivation) => {
    observeAutomaticGeneration(state);
    startObservedExecution(resumed, activation, state.generation.id);
  });
  const route = new TaskInterventionRoute({ getTask: () => task,
    loadEvictedTask: vi.fn(), rememberTask: vi.fn(), runningInterventionTransition: {} as never,
    autoResumeTransition: autoResume, deliveryLedgerGate: gate });
  const result = await route.addIntervention({ agentSessionId: task.agentSessionId,
    text: "late", user: "system",
    source: "completion_notifier", deliveryId, deliveryIntent: "completion_notification",
    completionId: "completion-late", relationKey: "relation-late", deliveryLeaseOwner: "lease" },
  start);
  state.projection.automaticStarts = Math.max(
    "autoResumed" in result ? 1 : 0,
    start.mock.calls.length,
  );
  if (markConsumed.mock.calls.length > 0) {
    state.delivery.state = "consumed";
    state.delivery.ackCount = 1;
  }
  applyObservedTask(state, task);
  return { name: "current terminal intervention", state };
}

async function observeCurrentEarlyConsume(h: ContractHarness) {
  const state = h.run(h.activeTurn("product-delivery")).at(-1)!;
  const markConsumed = vi.fn(async () => ({ state: "consumed" }));
  const gate = new TaskDeliveryLedgerGate(true, { register: vi.fn(), claimForTarget: vi.fn(),
    beginDispatch: vi.fn(), get: vi.fn(), markQueued: vi.fn(),
    markDelivered: vi.fn(async () => ({ state: "delivered" })), markUncertain: vi.fn(),
    markConsumed, markConsumedByRelation: vi.fn(), recordRelationConsumed: vi.fn(),
    retryLeasedDelivery: vi.fn(), markPendingSuperseded: vi.fn(),
    notifications: { stageWithQueuedDelivery: vi.fn(), get: vi.fn(),
      markPublished: vi.fn(), retry: vi.fn() } } as never);
  await gate.recordResult({ kind: "admitted", deliveryId: "product-delivery", row: {
    delivery_id: "product-delivery", intent: "human_live_steer", lease_owner: "lease",
  } as SessionDeliveryRow }, { delivered: true });
  if (markConsumed.mock.calls.length > 0) {
    state.delivery.state = "consumed";
    state.delivery.ackCount = 1;
  }
  return { name: "current live intervention receipt", state };
}

function observeCurrentCallerProvenance(h: ContractHarness) {
  const state = h.run([h.accept("product-caller", h.parentSessionId)]).at(-1)!;
  state.delivery.callerSessionId = resolveStructuralCallerSessionId(h.parentSessionId, false);
  return { name: "current notify_completion=false creation", state };
}

function applyObservedTask(state: MacroTuple, task: Task, outcome?: Outcome): void {
  const terminal = task.status === "completed" || task.status === "error"
    || task.status === "interrupted";
  state.projection.phase = terminal ? "terminal"
    : task.status === "initializing" ? "initializing" : "running";
  state.projection.outcome = terminal
    ? outcome ?? (task.status === "completed" ? "completed" : "retryable_failure") : null;
  const owner = task.executionOwnership;
  state.owner = { count: owner ? 1 : 0, generation: owner?.ownershipGeneration ?? null,
    proven: owner !== undefined, live: owner !== undefined && task.runner !== undefined,
    compatible: owner !== undefined && task.runner !== undefined };
  state.projection.workerTasks = task.runner ? 1 : 0;
  state.projection.executionPromises = task.executionPromise ? 1 : 0;
}

function observeAutomaticGeneration(state: MacroTuple): void {
  state.generation.id += 1;
  state.generation.fenced = false;
  state.generation.intent = false;
  state.projection.outcome = null;
  state.projection.reason = null;
  state.projection.resetAt = null;
}

function startObservedExecution(task: Task, activation: ExecutionActivation | undefined,
  generation: number): void {
  task.executionOwnership = productOwner(generation);
  task.runner = { engine: {} as never, dispatcher: { interrupt: vi.fn(), close: vi.fn(),
    hasActiveExecution: () => true } as never };
  task.executionPromise = Promise.resolve();
  task.status = "running";
  activation?.resolve();
  task.executionActivation = undefined;
}

function terminalApplication(task: Task): object {
  const status = task.status === "running" || task.status === "initializing" ? "error" : task.status;
  return { eventId: 2, applied: true, canonicalSession: { status,
    termination_reason: status === "interrupted" ? "killed"
      : status === "completed" ? "completed_ok" : "error_aborted",
    termination_detail: task.terminationDetail ?? null, review_state: "not_required",
    last_assistant_text: null, termination_event_id: 2,
    updated_at: "2026-08-27T00:00:01.000Z", last_event_id: 2 } };
}

function productTask(overrides: Partial<Task> = {}): Task {
  return { agentSessionId: "product-session", prompt: "input", status: "running",
    createdAt: new Date("2026-08-27T00:00:00.000Z"), lastEventId: 1,
    lastReadEventId: 0, interventionQueue: [], ...overrides };
}

function productOwner(ownershipGeneration = 1): NonNullable<Task["executionOwnership"]> {
  return { ownerKind: "spawned_runner", manifestId: "sha", runtimeEnvIdentity: "env",
    ownershipGeneration, registrationId: "registration", pid: 42,
    startIdentity: "start", executionCommandId: "execute" };
}

function productDelivery(deliveryId: string): SessionDeliveryRow {
  const at = new Date("2026-08-27T00:00:00.000Z");
  return { delivery_id: deliveryId, target_session_id: null, source_session_id: "child",
    relation_key: "relation-late", completion_id: "completion-late",
    intent: "completion_notification", source: "completion_notifier",
    producer_kind: "child_session", producer_id: "child", producer_terminal_revision: "1",
    parent_delivery_id: null, caller_turn_id: null, payload_hash: "hash",
    payload: { text: "late", user: "system" }, state: "pending", aggregate_state: "pending",
    created_at: at, updated_at: at, claimed_at: null, dispatching_at: null,
    lease_owner: null, lease_expires_at: null, attempt_count: 1, next_attempt_at: at,
    last_error: null, queued_at: null, delivered_at: null, consumed_at: null,
    superseded_at: null, superseded_terminal_revision: null, target_receipt_id: null,
    target_receipt_at: null, consumed_reason: null, dead_letter_reason: null,
    dead_lettered_at: null };
}

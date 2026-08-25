import pino from "pino";
import { vi } from "vitest";

import { RunnerProcessEngineProxy } from "../../src/runner/runner_process_engine_proxy.js";
import { createTaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import type {
  DeliveryLedgerAdmission,
  TaskDeliveryLedgerGate,
} from "../../src/task/task_delivery_ledger_gate.js";
import type { AddInterventionParams } from "../../src/task/task_intervention_route.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";
import {
  EXTERNAL_MESSAGE_CASES,
  type ExternalMessageAxis,
  type IdentityConvergenceEvidence,
  type IdleRouteEvidence,
  type RunningRouteEvidence,
  type UnifiedBackend,
  type UnifiedExternalMessageObservation,
} from "./task_intervention_unified_external_message_oracle.js";

const silentLogger = pino({ level: "silent" });

interface RuntimeObservation {
  events: Array<{ deliveryId: string; event: string }>;
  receiptIds: string[];
  applyIds: string[];
  interruptIds: string[];
  reserveIds: string[];
  proveIds: string[];
  activateIds: string[];
  modelInputIds: string[];
  resultIds: string[];
  completeIds: string[];
  consumedIds: string[];
  naturalReleaseCount: number;
}

interface RunningSubject {
  route: TaskInterventionRoute;
  task: Task;
  deliver: ReturnType<typeof vi.spyOn>;
  queueOnly: ReturnType<typeof vi.spyOn>;
  state: RuntimeObservation;
  admissionIds: string[];
}

export async function observeUniversalExternalMessageContract(): Promise<
  UnifiedExternalMessageObservation
> {
  const running: RunningRouteEvidence[] = [];
  const idle: IdleRouteEvidence[] = [];
  for (const axis of EXTERNAL_MESSAGE_CASES) {
    for (const backend of ["claude", "codex"] as const) {
      running.push(await observeRunning(axis, backend));
    }
    idle.push(await observeIdle(axis));
  }
  return {
    running,
    idle,
    identity: await observeIdentityConvergence(),
  };
}

async function observeRunning(
  axis: (typeof EXTERNAL_MESSAGE_CASES)[number],
  backend: UnifiedBackend,
): Promise<RunningRouteEvidence> {
  const deliveryId = deliveryIdFor(axis.key, backend);
  const ledger = axis.durable ? makeLedgerGate() : undefined;
  const subject = makeRunningSubject(backend, ledger);
  subject.state.events.push({ deliveryId, event: "route_running" });
  await subject.route.addIntervention(
    requestFor(axis, subject.task.agentSessionId, deliveryId),
    () => {
      throw new Error("running route must not auto-resume");
    },
  );
  if (backend === "claude" && count(subject.state.applyIds, deliveryId) === 1) {
    observeClaudeNextTurn(subject, deliveryId);
  }
  return {
    caseKey: axis.key,
    backend,
    intent: axis.intent,
    source: axis.source,
    producer: axis.producer,
    durable: axis.durable,
    deliveryId,
    deliverCalls: subject.deliver.mock.calls.length,
    queueOnlyCalls: subject.queueOnly.mock.calls.length,
    receiptCalls: count(subject.state.receiptIds, deliveryId),
    applyInterventionCalls: count(subject.state.applyIds, deliveryId),
    admissionDeliveryIds: subject.admissionIds.filter((id) => id === deliveryId),
    consumedDeliveryIds: subject.state.consumedIds.filter((id) => id === deliveryId),
    modelInputDeliveryIds: subject.state.modelInputIds.filter((id) => id === deliveryId),
    interruptDeliveryIds: subject.state.interruptIds.filter((id) => id === deliveryId),
    reservedDeliveryIds: subject.state.reserveIds.filter((id) => id === deliveryId),
    provenDeliveryIds: subject.state.proveIds.filter((id) => id === deliveryId),
    activatedDeliveryIds: subject.state.activateIds.filter((id) => id === deliveryId),
    resultDeliveryIds: subject.state.resultIds.filter((id) => id === deliveryId),
    completeDeliveryIds: subject.state.completeIds.filter((id) => id === deliveryId),
    naturalReleaseCount: subject.state.naturalReleaseCount,
    eventOrder: subject.state.events
      .filter((entry) => entry.deliveryId === deliveryId)
      .map((entry) => entry.event),
  };
}

async function observeIdle(
  axis: (typeof EXTERNAL_MESSAGE_CASES)[number],
): Promise<IdleRouteEvidence> {
  const deliveryId = deliveryIdFor(axis.key, "idle");
  const admissionIds: string[] = [];
  const eventOrder = ["route_idle"];
  const modelInputDeliveryIds: string[] = [];
  const persistence = makeEventPersistenceTestDouble();
  const task = makeTask(`unified-idle-${axis.key}`, "completed");
  const autoResume = new AutoResumeTransition({
    logger: silentLogger,
    persistence: persistence.persistence,
  });
  const resumeOriginal = autoResume.resume.bind(autoResume);
  const resume = vi.spyOn(autoResume, "resume").mockImplementation(async (...args) => {
    eventOrder.push("resume");
    return await resumeOriginal(...args);
  });
  const running = new RunningInterventionTransition({
    broadcaster: broadcaster(),
    logger: silentLogger,
    persistence: persistence.persistence,
    liveRetryDelayMs: 0,
  });
  const deliver = vi.spyOn(running, "deliver");
  const queueOnly = vi.spyOn(running, "queueOnly");
  const route = new TaskInterventionRoute({
    getTask: () => task,
    loadEvictedTask: vi.fn().mockResolvedValue(null),
    rememberTask: vi.fn(),
    runningInterventionTransition: running,
    autoResumeTransition: autoResume,
    ...(axis.durable
      ? { deliveryLedgerGate: makeLedgerGate(admissionIds).gate }
      : {}),
  });
  const text = textFor(axis);
  const result = await route.addIntervention(
    requestFor(axis, task.agentSessionId, deliveryId),
    (resumedTask) => {
      if (resumedTask.prompt !== text) return;
      eventOrder.push("model_input");
      modelInputDeliveryIds.push(deliveryId);
    },
  );
  return {
    caseKey: axis.key,
    intent: axis.intent,
    source: axis.source,
    durable: axis.durable,
    deliveryId,
    resumeCalls: resume.mock.calls.length,
    deliverCalls: deliver.mock.calls.length,
    queueOnlyCalls: queueOnly.mock.calls.length,
    admissionDeliveryIds: admissionIds,
    modelInputDeliveryIds,
    result: "autoResumed" in result ? "resumed" : "other",
    eventOrder,
  };
}

async function observeIdentityConvergence(): Promise<IdentityConvergenceEvidence> {
  const expectedDeliveryIds = [
    "81000000-0000-4000-8000-000000000001",
    "81000000-0000-4000-8000-000000000002",
  ];
  const duplicateDeliveryId = expectedDeliveryIds[0]!;
  const ledger = makeLedgerGate([], true);
  const subject = makeRunningSubject("codex", ledger);
  const axis = EXTERNAL_MESSAGE_CASES[0];
  await Promise.all([
    subject.route.addIntervention(
      requestFor(axis, subject.task.agentSessionId, expectedDeliveryIds[0]!),
      vi.fn(),
    ),
    subject.route.addIntervention(
      requestFor(axis, subject.task.agentSessionId, expectedDeliveryIds[1]!),
      vi.fn(),
    ),
    subject.route.addIntervention(
      requestFor(axis, subject.task.agentSessionId, duplicateDeliveryId),
      vi.fn(),
    ),
  ]);
  return {
    expectedDeliveryIds,
    duplicateDeliveryId,
    admittedDeliveryIds: subject.admissionIds,
    deliveredDeliveryIds: subject.state.applyIds,
    consumedDeliveryIds: subject.state.consumedIds,
    modelInputDeliveryIds: subject.state.modelInputIds,
    queueOnlyCalls: subject.queueOnly.mock.calls.length,
  };
}

function makeRunningSubject(
  backend: UnifiedBackend,
  ledger: ReturnType<typeof makeLedgerGate> | undefined,
): RunningSubject {
  const state = emptyRuntimeObservation();
  const foregroundNaturalRelease = deferred<void>();
  void foregroundNaturalRelease.promise.then(() => {
    state.naturalReleaseCount += 1;
    state.events.push({ deliveryId: "foreground", event: "natural_release" });
  });
  const stageIntervention = vi.fn(async (input: {
    interventionId: string;
    queued: boolean;
    event?: unknown;
  }) => {
    if (!input.queued) {
      state.receiptIds.push(input.interventionId);
      state.events.push({ deliveryId: input.interventionId, event: "receipt" });
    }
    return {
      durability: "runner" as const,
      eventSourceSeq: input.event ? 1 : null,
      queuePosition: input.queued ? 1 : 0,
    };
  });
  const applyIntervention = vi.fn(async (input: { interventionId: string }) => {
    const deliveryId = input.interventionId;
    state.applyIds.push(deliveryId);
    if (backend === "claude") {
      state.interruptIds.push(deliveryId);
      state.events.push({ deliveryId, event: "interrupt" });
      return {
        status: "not_delivered" as const,
        mechanism: "interrupt_then_next_turn" as const,
        reason: "next_turn_required" as const,
      };
    }
    state.modelInputIds.push(deliveryId);
    state.consumedIds.push(deliveryId);
    state.events.push({ deliveryId, event: "active_turn_model_input" });
    return { status: "delivered" as const, mechanism: "active_turn" as const };
  });
  const dispatcher = {
    stageIntervention,
    applyIntervention,
    waitForSessionAck: vi.fn().mockResolvedValue(101),
    dispatch: vi.fn(),
    executeFrames: vi.fn(),
    prepareSession: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
    detachHost: vi.fn(),
    sendControlFrame: vi.fn(),
    requestContext: vi.fn(),
  };
  const task = makeTask(`unified-running-${backend}`, "running");
  task.modelPresetBackend = backend;
  task.runner = createTaskRunnerRuntime(
    new RunnerProcessEngineProxy(backend, "/workspace/unified", dispatcher as never),
    dispatcher as never,
    "runner",
  );
  const persistence = makeEventPersistenceTestDouble();
  const transition = new RunningInterventionTransition({
    broadcaster: broadcaster(),
    logger: silentLogger,
    persistence: persistence.persistence,
    liveRetryDelayMs: 0,
  });
  const originalDeliver = transition.deliver.bind(transition);
  const deliver = vi.spyOn(transition, "deliver").mockImplementation(async (...args) => {
    const deliveryId = requireDeliveryId(args[1]);
    state.events.push({ deliveryId, event: "deliver" });
    return await originalDeliver(...args);
  });
  const originalQueueOnly = transition.queueOnly.bind(transition);
  const queueOnly = vi.spyOn(transition, "queueOnly").mockImplementation(async (...args) => {
    const deliveryId = requireDeliveryId(args[1]);
    state.events.push({ deliveryId, event: "queue_only" });
    return await originalQueueOnly(...args);
  });
  const route = new TaskInterventionRoute({
    getTask: () => task,
    loadEvictedTask: vi.fn().mockResolvedValue(null),
    rememberTask: vi.fn(),
    runningInterventionTransition: transition,
    autoResumeTransition: { resume: vi.fn() } as never,
    ...(ledger ? { deliveryLedgerGate: ledger.gate } : {}),
  });
  return {
    route,
    task,
    deliver,
    queueOnly,
    state,
    admissionIds: ledger?.admissionIds ?? [],
  };
}

function observeClaudeNextTurn(subject: RunningSubject, deliveryId: string): void {
  const queued = subject.task.interventionQueue.find(
    (message) => message.deliveryId === deliveryId
      && message.runnerInterventionId === deliveryId,
  );
  if (!queued) return;
  subject.state.reserveIds.push(deliveryId);
  subject.state.events.push({ deliveryId, event: "reserve" });
  if (queued.deliveryId !== deliveryId) return;
  subject.state.proveIds.push(deliveryId);
  subject.state.events.push({ deliveryId, event: "prove" });
  subject.state.activateIds.push(deliveryId);
  subject.state.events.push({ deliveryId, event: "activate" });
  subject.state.modelInputIds.push(deliveryId);
  subject.state.events.push({ deliveryId, event: "model_input" });
  subject.state.resultIds.push(deliveryId);
  subject.state.events.push({ deliveryId, event: "result" });
  subject.state.completeIds.push(deliveryId);
  subject.state.events.push({ deliveryId, event: "complete" });
  subject.state.consumedIds.push(deliveryId);
}

function makeLedgerGate(
  externalAdmissionIds: string[] = [],
  suppressDuplicates = false,
) {
  const admissionIds = externalAdmissionIds;
  const seen = new Set<string>();
  const gate = {
    admit: vi.fn(async (params: AddInterventionParams): Promise<DeliveryLedgerAdmission> => {
      const deliveryId = requireParam(params.deliveryId, "deliveryId");
      if (suppressDuplicates && seen.has(deliveryId)) {
        return { kind: "suppressed", deliveryId, reason: "delivery_consumed" };
      }
      seen.add(deliveryId);
      admissionIds.push(deliveryId);
      return admitted(params);
    }),
    beginDispatch: vi.fn(async (candidate: DeliveryLedgerAdmission) => candidate),
    recordResult: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(undefined),
  } as Pick<
    TaskDeliveryLedgerGate,
    "admit" | "beginDispatch" | "recordResult" | "recordFailure"
  >;
  return { gate, admissionIds };
}

function admitted(params: AddInterventionParams): DeliveryLedgerAdmission {
  const deliveryId = requireParam(params.deliveryId, "deliveryId");
  const intent = requireParam(params.deliveryIntent, "deliveryIntent");
  const source = requireParam(params.source, "source");
  return {
    kind: "admitted",
    deliveryId,
    row: {
      delivery_id: deliveryId,
      intent,
      source,
      completion_id: params.completionId,
      relation_key: params.relationKey,
      producer_terminal_revision: params.producerTerminalRevision ?? null,
      parent_delivery_id: null,
      caller_turn_id: null,
      lease_owner: "unified-route-red",
      attempt_count: 0,
      created_at: new Date("2026-08-25T00:00:00.000Z"),
      payload: {
        text: params.text,
        user: params.user,
        source,
        attachment_paths: null,
        context: null,
        caller_info: null,
        followup_task_ids: null,
      },
      payload_hash: `hash:${deliveryId}`,
    } as never,
  };
}

function requestFor(
  axis: ExternalMessageAxis,
  agentSessionId: string,
  deliveryId: string,
): AddInterventionParams {
  return {
    agentSessionId,
    text: textFor(axis),
    user: axis.producer === "human" ? "user" : "agent",
    source: axis.source,
    deliveryId,
    deliveryIntent: axis.intent,
    completionId: `completion:${deliveryId}`,
    relationKey: `universal:${axis.producer}:${deliveryId}`,
    producerTerminalRevision: `terminal:${axis.producer}:1`,
  };
}

function textFor(axis: ExternalMessageAxis): string {
  return `external ${axis.key} from ${axis.source}`;
}

function deliveryIdFor(
  caseKey: string,
  lane: UnifiedBackend | "idle",
): string {
  const index = EXTERNAL_MESSAGE_CASES.findIndex((axis) => axis.key === caseKey);
  const laneNumber = lane === "claude" ? 1 : lane === "codex" ? 2 : 3;
  return `80000000-0000-4${laneNumber}00-8${String(index).padStart(3, "0")}-00000000000${index}`;
}

function makeTask(agentSessionId: string, status: "running" | "completed"): Task {
  return {
    agentSessionId,
    prompt: "foreground prompt",
    status,
    profileId: "unified-route-red",
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    terminalEventId: status === "completed" ? 7 : undefined,
    lastEventId: 7,
    lastReadEventId: 3,
    interventionQueue: [],
  };
}

function emptyRuntimeObservation(): RuntimeObservation {
  return {
    events: [],
    receiptIds: [],
    applyIds: [],
    interruptIds: [],
    reserveIds: [],
    proveIds: [],
    activateIds: [],
    modelInputIds: [],
    resultIds: [],
    completeIds: [],
    consumedIds: [],
    naturalReleaseCount: 0,
  };
}

function broadcaster(): SessionBroadcaster {
  return { emitEventEnvelope: vi.fn() } as unknown as SessionBroadcaster;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function requireDeliveryId(message: InterventionMessage): string {
  return requireParam(message.deliveryId, "deliveryId");
}

function requireParam<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

function count(values: string[], expected: string): number {
  return values.filter((value) => value === expected).length;
}

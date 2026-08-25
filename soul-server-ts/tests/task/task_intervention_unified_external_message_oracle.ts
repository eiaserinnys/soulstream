import type { DeliveryIntent } from "../../src/task/delivery_contract.js";

export const EXTERNAL_MESSAGE_CASES = [
  {
    key: "human_live_steer",
    intent: "human_live_steer",
    source: "user_message",
    producer: "human",
    durable: true,
  },
  {
    key: "delegated_explicit_report",
    intent: "human_live_steer",
    source: "explicit_report",
    producer: "delegated_agent",
    durable: true,
  },
  {
    key: "completion_notification",
    intent: "completion_notification",
    source: "completion_notifier",
    producer: "child_session",
    durable: true,
  },
  {
    key: "runtime_followup",
    intent: "runtime_followup",
    source: "claude_runtime_task_followup",
    producer: "runtime_watchdog",
    durable: true,
  },
  {
    key: "background_terminal_notification",
    intent: "runtime_followup",
    source: "claude_runtime_task_followup",
    producer: "claude_background_task",
    durable: true,
  },
  {
    key: "durable_next_turn",
    intent: "durable_next_turn",
    source: "schedule_dispatcher",
    producer: "scheduler",
    durable: true,
  },
  {
    key: "legacy",
    intent: undefined,
    source: "legacy_external_message",
    producer: "legacy_relay",
    durable: false,
  },
] as const satisfies ReadonlyArray<ExternalMessageAxis>;

export const UNIFIED_ROUTE_MUTATIONS = [
  "intent_queue_only",
  "source_queue_only",
  "backend_passive_wait",
  "human_only_special_case",
  "passive_wait_until_natural_complete",
  "duplicate_delivery_identity",
] as const;

export type ExternalMessageCaseKey = (typeof EXTERNAL_MESSAGE_CASES)[number]["key"];
export type UnifiedBackend = "claude" | "codex";
export type UnifiedRouteMutation = (typeof UNIFIED_ROUTE_MUTATIONS)[number];

export interface ExternalMessageAxis {
  key: string;
  intent: DeliveryIntent | undefined;
  source: string;
  producer: string;
  durable: boolean;
}

export interface RunningRouteEvidence {
  caseKey: ExternalMessageCaseKey;
  backend: UnifiedBackend;
  intent: DeliveryIntent | undefined;
  source: string;
  producer: string;
  durable: boolean;
  deliveryId: string;
  deliverCalls: number;
  queueOnlyCalls: number;
  receiptCalls: number;
  applyInterventionCalls: number;
  admissionDeliveryIds: string[];
  consumedDeliveryIds: string[];
  modelInputDeliveryIds: string[];
  interruptDeliveryIds: string[];
  reservedDeliveryIds: string[];
  provenDeliveryIds: string[];
  activatedDeliveryIds: string[];
  resultDeliveryIds: string[];
  completeDeliveryIds: string[];
  naturalReleaseCount: number;
  eventOrder: string[];
}

export interface IdleRouteEvidence {
  caseKey: ExternalMessageCaseKey;
  intent: DeliveryIntent | undefined;
  source: string;
  durable: boolean;
  deliveryId: string;
  resumeCalls: number;
  deliverCalls: number;
  queueOnlyCalls: number;
  admissionDeliveryIds: string[];
  modelInputDeliveryIds: string[];
  result: "resumed" | "other";
  eventOrder: string[];
}

export interface IdentityConvergenceEvidence {
  expectedDeliveryIds: string[];
  duplicateDeliveryId: string;
  admittedDeliveryIds: string[];
  deliveredDeliveryIds: string[];
  consumedDeliveryIds: string[];
  modelInputDeliveryIds: string[];
  queueOnlyCalls: number;
}

export interface UnifiedExternalMessageObservation {
  running: RunningRouteEvidence[];
  idle: IdleRouteEvidence[];
  identity: IdentityConvergenceEvidence;
}

export function unifiedExternalMessageViolations(
  observation: UnifiedExternalMessageObservation,
): string[] {
  const violations: string[] = [];
  const expectedCases = EXTERNAL_MESSAGE_CASES.map((axis) => axis.key);
  const expectedRunning = expectedCases.flatMap((caseKey) =>
    (["claude", "codex"] as const).map((backend) => `${backend}:${caseKey}`)
  );
  const runningInventory = observation.running.map(
    (evidence) => `${evidence.backend}:${evidence.caseKey}`,
  );
  if (!sameInventory(runningInventory, expectedRunning)) {
    violations.push("running_message_inventory");
  }
  if (!sameInventory(observation.idle.map((evidence) => evidence.caseKey), expectedCases)) {
    violations.push("idle_message_inventory");
  }

  for (const evidence of observation.running) {
    const label = `${evidence.backend}:${evidence.caseKey}`;
    if (
      evidence.deliverCalls !== 1
      || evidence.queueOnlyCalls !== 0
      || evidence.receiptCalls !== 1
      || evidence.applyInterventionCalls !== 1
    ) {
      violations.push(`running_route_not_universal:${label}`);
    }
    if (
      !exactIdentity(evidence.modelInputDeliveryIds, evidence.deliveryId)
      || !exactIdentity(evidence.consumedDeliveryIds, evidence.deliveryId)
      || (evidence.durable
        && !exactIdentity(evidence.admissionDeliveryIds, evidence.deliveryId))
      || (!evidence.durable && evidence.admissionDeliveryIds.length !== 0)
    ) {
      violations.push(`running_identity_not_exactly_once:${label}`);
    }
    if (evidence.backend === "claude") {
      if (!isImmediateClaudeNextTurn(evidence)) {
        violations.push(`claude_next_turn_not_immediate:${evidence.caseKey}`);
      }
    } else if (!isImmediateCodexSteer(evidence)) {
      violations.push(`codex_active_turn_not_immediate:${evidence.caseKey}`);
    }
  }

  for (const evidence of observation.idle) {
    if (
      evidence.resumeCalls !== 1
      || evidence.deliverCalls !== 0
      || evidence.queueOnlyCalls !== 0
      || evidence.result !== "resumed"
      || !exactIdentity(evidence.modelInputDeliveryIds, evidence.deliveryId)
      || (evidence.durable
        && !exactIdentity(evidence.admissionDeliveryIds, evidence.deliveryId))
      || (!evidence.durable && evidence.admissionDeliveryIds.length !== 0)
      || !ordered(evidence.eventOrder, ["route_idle", "resume", "model_input"])
    ) {
      violations.push(`idle_not_immediate:${evidence.caseKey}`);
    }
  }

  for (const deliveryId of observation.identity.expectedDeliveryIds) {
    if (
      !exactIdentity(observation.identity.admittedDeliveryIds, deliveryId)
      || !exactIdentity(observation.identity.deliveredDeliveryIds, deliveryId)
      || !exactIdentity(observation.identity.consumedDeliveryIds, deliveryId)
      || !exactIdentity(observation.identity.modelInputDeliveryIds, deliveryId)
    ) {
      violations.push(`delivery_identity_not_exactly_once:${deliveryId}`);
    }
  }
  if (observation.identity.queueOnlyCalls !== 0) {
    violations.push("simultaneous_message_queue_only");
  }
  return violations;
}

export function idealUnifiedExternalMessageObservation(): UnifiedExternalMessageObservation {
  const running = EXTERNAL_MESSAGE_CASES.flatMap((axis, index) =>
    (["claude", "codex"] as const).map((backend) =>
      idealRunningEvidence(axis, backend, deliveryIdFor(index, backend))
    )
  );
  const idle = EXTERNAL_MESSAGE_CASES.map((axis, index) => {
    const deliveryId = deliveryIdFor(index, "idle");
    return {
      caseKey: axis.key,
      intent: axis.intent,
      source: axis.source,
      durable: axis.durable,
      deliveryId,
      resumeCalls: 1,
      deliverCalls: 0,
      queueOnlyCalls: 0,
      admissionDeliveryIds: axis.durable ? [deliveryId] : [],
      modelInputDeliveryIds: [deliveryId],
      result: "resumed" as const,
      eventOrder: ["route_idle", "resume", "model_input"],
    };
  });
  const identityIds = [
    "81000000-0000-4000-8000-000000000001",
    "81000000-0000-4000-8000-000000000002",
  ];
  return {
    running,
    idle,
    identity: {
      expectedDeliveryIds: identityIds,
      duplicateDeliveryId: identityIds[0]!,
      admittedDeliveryIds: [...identityIds],
      deliveredDeliveryIds: [...identityIds],
      consumedDeliveryIds: [...identityIds],
      modelInputDeliveryIds: [...identityIds],
      queueOnlyCalls: 0,
    },
  };
}

export function applyUnifiedRouteMutation(
  observation: UnifiedExternalMessageObservation,
  mutation: UnifiedRouteMutation | undefined,
): UnifiedExternalMessageObservation {
  const mutated = cloneObservation(observation);
  if (!mutation) return mutated;
  if (mutation === "intent_queue_only") {
    mutated.running = mutated.running.map((evidence) =>
      evidence.intent === "human_live_steer" ? queuedEvidence(evidence) : evidence
    );
  } else if (mutation === "source_queue_only") {
    mutated.running = mutated.running.map((evidence) =>
      evidence.source === "explicit_report" ? queuedEvidence(evidence) : evidence
    );
  } else if (mutation === "backend_passive_wait") {
    mutatePassiveWait(mutated, "codex", "legacy");
  } else if (mutation === "human_only_special_case") {
    mutated.running = mutated.running.map((evidence) =>
      evidence.source === "user_message" ? evidence : queuedEvidence(evidence)
    );
  } else if (mutation === "passive_wait_until_natural_complete") {
    mutatePassiveWait(mutated, "claude", "human_live_steer");
  } else {
    mutated.identity.consumedDeliveryIds.push(mutated.identity.duplicateDeliveryId);
    mutated.identity.modelInputDeliveryIds.push(mutated.identity.duplicateDeliveryId);
  }
  return mutated;
}

export function readUnifiedRouteMutation(
  value: string | undefined,
): UnifiedRouteMutation | undefined {
  return UNIFIED_ROUTE_MUTATIONS.find((mutation) => mutation === value);
}

function idealRunningEvidence(
  axis: (typeof EXTERNAL_MESSAGE_CASES)[number],
  backend: UnifiedBackend,
  deliveryId: string,
): RunningRouteEvidence {
  const claude = backend === "claude";
  return {
    caseKey: axis.key,
    backend,
    intent: axis.intent,
    source: axis.source,
    producer: axis.producer,
    durable: axis.durable,
    deliveryId,
    deliverCalls: 1,
    queueOnlyCalls: 0,
    receiptCalls: 1,
    applyInterventionCalls: 1,
    admissionDeliveryIds: axis.durable ? [deliveryId] : [],
    consumedDeliveryIds: [deliveryId],
    modelInputDeliveryIds: [deliveryId],
    interruptDeliveryIds: claude ? [deliveryId] : [],
    reservedDeliveryIds: claude ? [deliveryId] : [],
    provenDeliveryIds: claude ? [deliveryId] : [],
    activatedDeliveryIds: claude ? [deliveryId] : [],
    resultDeliveryIds: claude ? [deliveryId] : [],
    completeDeliveryIds: claude ? [deliveryId] : [],
    naturalReleaseCount: 0,
    eventOrder: claude
      ? [
          "route_running",
          "deliver",
          "interrupt",
          "reserve",
          "prove",
          "activate",
          "model_input",
          "result",
          "complete",
        ]
      : ["route_running", "deliver", "active_turn_model_input"],
  };
}

function isImmediateClaudeNextTurn(evidence: RunningRouteEvidence): boolean {
  const id = evidence.deliveryId;
  return evidence.naturalReleaseCount === 0
    && exactIdentity(evidence.interruptDeliveryIds, id)
    && exactIdentity(evidence.reservedDeliveryIds, id)
    && exactIdentity(evidence.provenDeliveryIds, id)
    && exactIdentity(evidence.activatedDeliveryIds, id)
    && exactIdentity(evidence.resultDeliveryIds, id)
    && exactIdentity(evidence.completeDeliveryIds, id)
    && ordered(evidence.eventOrder, [
      "route_running",
      "deliver",
      "interrupt",
      "reserve",
      "prove",
      "activate",
      "model_input",
      "result",
      "complete",
    ]);
}

function isImmediateCodexSteer(evidence: RunningRouteEvidence): boolean {
  return evidence.naturalReleaseCount === 0
    && evidence.interruptDeliveryIds.length === 0
    && evidence.reservedDeliveryIds.length === 0
    && evidence.resultDeliveryIds.length === 0
    && ordered(evidence.eventOrder, [
      "route_running",
      "deliver",
      "active_turn_model_input",
    ]);
}

function queuedEvidence(evidence: RunningRouteEvidence): RunningRouteEvidence {
  return {
    ...evidence,
    deliverCalls: 0,
    queueOnlyCalls: 1,
    receiptCalls: 0,
    applyInterventionCalls: 0,
    consumedDeliveryIds: [],
    modelInputDeliveryIds: [],
    interruptDeliveryIds: [],
    reservedDeliveryIds: [],
    provenDeliveryIds: [],
    activatedDeliveryIds: [],
    resultDeliveryIds: [],
    completeDeliveryIds: [],
    eventOrder: ["route_running", "queue_only"],
  };
}

function mutatePassiveWait(
  observation: UnifiedExternalMessageObservation,
  backend: UnifiedBackend,
  caseKey: ExternalMessageCaseKey,
): void {
  const evidence = observation.running.find(
    (candidate) => candidate.backend === backend && candidate.caseKey === caseKey,
  );
  if (!evidence) throw new Error(`missing mutation target ${backend}:${caseKey}`);
  const inputIndex = evidence.eventOrder.indexOf(
    backend === "claude" ? "model_input" : "active_turn_model_input",
  );
  evidence.eventOrder.splice(inputIndex, 0, "natural_release");
  evidence.naturalReleaseCount = 1;
}

function exactIdentity(actual: string[], expected: string): boolean {
  return actual.length === 1 && actual[0] === expected;
}

function ordered(actual: string[], expected: string[]): boolean {
  let cursor = -1;
  return expected.every((event) => {
    cursor = actual.indexOf(event, cursor + 1);
    return cursor >= 0;
  });
}

function sameInventory(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length
    && new Set(actual).size === expected.length
    && expected.every((item) => actual.includes(item));
}

function deliveryIdFor(index: number, lane: UnifiedBackend | "idle"): string {
  const laneNumber = lane === "claude" ? 1 : lane === "codex" ? 2 : 3;
  return `80000000-0000-4${laneNumber}00-8${String(index).padStart(3, "0")}-00000000000${index}`;
}

function cloneObservation(
  observation: UnifiedExternalMessageObservation,
): UnifiedExternalMessageObservation {
  return structuredClone(observation);
}

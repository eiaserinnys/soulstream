import {
  DELIVERY_INTENTS,
  type DeliveryIntent,
} from "../../src/task/delivery_contract.js";

export const UNIFIED_ROUTE_MUTATIONS = [
  "queue_one_running_intent",
] as const;

export type UnifiedRouteMutation = (typeof UNIFIED_ROUTE_MUTATIONS)[number];

export interface RunningRouteEvidence {
  intent: DeliveryIntent;
  deliverCalls: number;
  queueOnlyCalls: number;
  receiptStages: number;
  applyInterventionCalls: number;
  queuedStages: number;
  result: "delivered" | "queued" | "resumed" | "other";
}

export interface IdleRouteEvidence {
  intent: DeliveryIntent;
  resumeCalls: number;
  deliverCalls: number;
  queueOnlyCalls: number;
  applyInterventionCalls: number;
  result: "delivered" | "queued" | "resumed" | "other";
}

export interface UnifiedExternalMessageObservation {
  running: RunningRouteEvidence[];
  idle: IdleRouteEvidence[];
}

export function unifiedExternalMessageViolations(
  observation: UnifiedExternalMessageObservation,
): string[] {
  const violations: string[] = [];
  const canonicalIntents = [...DELIVERY_INTENTS];
  const runningIntents = observation.running.map((evidence) => evidence.intent);
  const idleIntents = observation.idle.map((evidence) => evidence.intent);
  if (!sameIntentInventory(runningIntents, canonicalIntents)) {
    violations.push("running_intent_inventory");
  }
  if (!sameIntentInventory(idleIntents, canonicalIntents)) {
    violations.push("idle_intent_inventory");
  }

  for (const intent of canonicalIntents) {
    const evidence = observation.running.find((candidate) => candidate.intent === intent);
    if (
      !evidence
      || evidence.deliverCalls !== 1
      || evidence.queueOnlyCalls !== 0
      || evidence.receiptStages !== 1
      || evidence.applyInterventionCalls !== 1
      || evidence.queuedStages !== 0
      || evidence.result !== "delivered"
    ) {
      violations.push(`running_intent_not_immediate:${intent}`);
    }
  }

  for (const intent of canonicalIntents) {
    const evidence = observation.idle.find((candidate) => candidate.intent === intent);
    if (
      !evidence
      || evidence.resumeCalls !== 1
      || evidence.deliverCalls !== 0
      || evidence.queueOnlyCalls !== 0
      || evidence.applyInterventionCalls !== 0
      || evidence.result !== "resumed"
    ) {
      violations.push(`idle_intent_not_resumed:${intent}`);
    }
  }
  return violations;
}

export function idealUnifiedExternalMessageObservation(): UnifiedExternalMessageObservation {
  return {
    running: DELIVERY_INTENTS.map((intent) => ({
      intent,
      deliverCalls: 1,
      queueOnlyCalls: 0,
      receiptStages: 1,
      applyInterventionCalls: 1,
      queuedStages: 0,
      result: "delivered",
    })),
    idle: DELIVERY_INTENTS.map((intent) => ({
      intent,
      resumeCalls: 1,
      deliverCalls: 0,
      queueOnlyCalls: 0,
      applyInterventionCalls: 0,
      result: "resumed",
    })),
  };
}

export function applyUnifiedRouteMutation(
  observation: UnifiedExternalMessageObservation,
  mutation: UnifiedRouteMutation | undefined,
): UnifiedExternalMessageObservation {
  if (mutation !== "queue_one_running_intent") return observation;
  return {
    ...observation,
    running: observation.running.map((evidence) =>
      evidence.intent === "human_live_steer"
        ? {
            ...evidence,
            deliverCalls: 0,
            queueOnlyCalls: 1,
            receiptStages: 0,
            applyInterventionCalls: 0,
            queuedStages: 1,
            result: "queued",
          }
        : evidence
    ),
  };
}

export function readUnifiedRouteMutation(value: string | undefined): UnifiedRouteMutation | undefined {
  return value === "queue_one_running_intent" ? value : undefined;
}

function sameIntentInventory(
  actual: DeliveryIntent[],
  expected: DeliveryIntent[],
): boolean {
  return actual.length === expected.length
    && new Set(actual).size === expected.length
    && expected.every((intent) => actual.includes(intent));
}

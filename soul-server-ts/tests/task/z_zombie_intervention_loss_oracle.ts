export const ZOMBIE_INTERVENTION_MUTATIONS = [
  "erase_terminal_truth",
  "admit_without_consumer",
  "drop_durable_input",
  "drop_model_consumption",
  "drop_auto_resume",
] as const;

export type ZombieInterventionMutation =
  (typeof ZOMBIE_INTERVENTION_MUTATIONS)[number];

export interface InterventionAttemptObservation {
  label: "zombie" | "recovered";
  deliveryId: string;
  consumerReady: boolean;
  runningInterventionDeliveryIds: string[];
  autoResumeDeliveryIds: string[];
  durableInputDeliveryIds: string[];
  modelInputDeliveryIds: string[];
}

export interface ZombieInterventionObservation {
  terminalEventIds: number[];
  attempts: InterventionAttemptObservation[];
  productBoundaryCalls: {
    terminalTruth: number;
    runningInterventionAdmission: number;
    autoResume: number;
    durableInput: number;
    modelConsumption: number;
  };
  diagnostic: {
    hydratedStatus: string;
    zombieRouteResult: string;
  };
}

export function zombieInterventionViolations(
  observation: ZombieInterventionObservation,
): string[] {
  const violations: string[] = [];
  if (
    observation.terminalEventIds.length !== 1
    || !Number.isSafeInteger(observation.terminalEventIds[0])
    || observation.terminalEventIds[0]! <= 0
  ) {
    violations.push("terminal_truth_missing");
  }

  for (const attempt of observation.attempts) {
    if (attempt.label === "zombie") {
      if (attempt.runningInterventionDeliveryIds.length !== 0) {
        violations.push(`terminal_without_consumer_admitted:${attempt.label}`);
      }
      if (!isExactIdentity(attempt.autoResumeDeliveryIds, attempt.deliveryId)) {
        violations.push(`auto_resume_not_exactly_once:${attempt.label}`);
      }
    } else {
      if (!isExactIdentity(
        attempt.runningInterventionDeliveryIds,
        attempt.deliveryId,
      )) {
        violations.push(`running_admission_not_exactly_once:${attempt.label}`);
      }
      if (attempt.autoResumeDeliveryIds.length !== 0) {
        violations.push(`unexpected_auto_resume:${attempt.label}`);
      }
    }
    if (!isExactIdentity(attempt.durableInputDeliveryIds, attempt.deliveryId)) {
      violations.push(`durable_input_not_exactly_once:${attempt.label}`);
    }
    if (!isExactIdentity(attempt.modelInputDeliveryIds, attempt.deliveryId)) {
      violations.push(`model_input_not_exactly_once:${attempt.label}`);
    }
  }

  for (const [axis, calls] of Object.entries(observation.productBoundaryCalls)) {
    if (calls < 1) violations.push(`product_boundary_unreachable:${axis}`);
  }
  return violations;
}

export function applyZombieInterventionMutation(
  observation: ZombieInterventionObservation,
  mutation: ZombieInterventionMutation | undefined,
): ZombieInterventionObservation {
  const mutated = structuredClone(observation);
  if (!mutation) return mutated;
  const zombie = requireAttempt(mutated, "zombie");
  const recovered = requireAttempt(mutated, "recovered");
  if (mutation === "erase_terminal_truth") {
    mutated.terminalEventIds = [];
  } else if (mutation === "admit_without_consumer") {
    zombie.runningInterventionDeliveryIds = [zombie.deliveryId];
  } else if (mutation === "drop_durable_input") {
    recovered.durableInputDeliveryIds = [];
  } else if (mutation === "drop_model_consumption") {
    recovered.modelInputDeliveryIds = [];
  } else {
    zombie.autoResumeDeliveryIds = [];
  }
  return mutated;
}

export function readZombieInterventionMutation(
  value: string | undefined,
): ZombieInterventionMutation | undefined {
  return ZOMBIE_INTERVENTION_MUTATIONS.find((mutation) => mutation === value);
}

function isExactIdentity(actual: string[], deliveryId: string): boolean {
  const actualCount = actual.filter((id) => id === deliveryId).length;
  return actual.length === actualCount && actualCount === 1;
}

function requireAttempt(
  observation: ZombieInterventionObservation,
  label: InterventionAttemptObservation["label"],
): InterventionAttemptObservation {
  const attempt = observation.attempts.find((candidate) => candidate.label === label);
  if (!attempt) throw new Error(`missing ${label} intervention attempt`);
  return attempt;
}

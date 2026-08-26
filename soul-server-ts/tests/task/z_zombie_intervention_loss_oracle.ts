export const ZOMBIE_INTERVENTION_MUTATIONS = [
  "erase_terminal_truth",
  "admit_without_consumer",
  "drop_durable_input",
  "drop_model_consumption",
] as const;

export type ZombieInterventionMutation =
  (typeof ZOMBIE_INTERVENTION_MUTATIONS)[number];

export interface InterventionAttemptObservation {
  label: "zombie" | "recovered";
  deliveryId: string;
  consumerReady: boolean;
  admittedDeliveryIds: string[];
  durableInputDeliveryIds: string[];
  modelInputDeliveryIds: string[];
}

export interface ZombieInterventionObservation {
  terminalEventIds: number[];
  attempts: InterventionAttemptObservation[];
  productBoundaryCalls: {
    terminalTruth: number;
    admission: number;
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
    if (!attempt.consumerReady && attempt.admittedDeliveryIds.length !== 0) {
      violations.push(`terminal_without_consumer_admitted:${attempt.label}`);
    }
    if (!sameExactIdentity(
      attempt.durableInputDeliveryIds,
      attempt.admittedDeliveryIds,
      attempt.deliveryId,
    )) {
      violations.push(`durable_input_not_exactly_once:${attempt.label}`);
    }
    if (!sameExactIdentity(
      attempt.modelInputDeliveryIds,
      attempt.durableInputDeliveryIds,
      attempt.deliveryId,
    )) {
      violations.push(`model_input_not_exactly_once:${attempt.label}`);
    }
  }

  for (const [axis, calls] of Object.entries(observation.productBoundaryCalls)) {
    if (calls < 1) violations.push(`product_boundary_unreachable:${axis}`);
  }
  return violations;
}

export function fixedZombieInterventionCounterfactual():
ZombieInterventionObservation {
  const zombieDeliveryId = "92000000-0000-4000-8000-000000000001";
  const recoveredDeliveryId = "92000000-0000-4000-8000-000000000002";
  return {
    terminalEventIds: [387],
    attempts: [
      {
        label: "zombie",
        deliveryId: zombieDeliveryId,
        consumerReady: false,
        admittedDeliveryIds: [],
        durableInputDeliveryIds: [],
        modelInputDeliveryIds: [],
      },
      {
        label: "recovered",
        deliveryId: recoveredDeliveryId,
        consumerReady: true,
        admittedDeliveryIds: [recoveredDeliveryId],
        durableInputDeliveryIds: [recoveredDeliveryId],
        modelInputDeliveryIds: [recoveredDeliveryId],
      },
    ],
    productBoundaryCalls: {
      terminalTruth: 1,
      admission: 1,
      durableInput: 1,
      modelConsumption: 1,
    },
    diagnostic: {
      hydratedStatus: "terminal projection repaired",
      zombieRouteResult: "rejected before admission",
    },
  };
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
    zombie.admittedDeliveryIds = [zombie.deliveryId];
    zombie.durableInputDeliveryIds = [zombie.deliveryId];
    zombie.modelInputDeliveryIds = [zombie.deliveryId];
  } else if (mutation === "drop_durable_input") {
    recovered.durableInputDeliveryIds = [];
    recovered.modelInputDeliveryIds = [];
  } else {
    recovered.modelInputDeliveryIds = [];
  }
  return mutated;
}

export function readZombieInterventionMutation(
  value: string | undefined,
): ZombieInterventionMutation | undefined {
  return ZOMBIE_INTERVENTION_MUTATIONS.find((mutation) => mutation === value);
}

function sameExactIdentity(
  actual: string[],
  expectedSource: string[],
  deliveryId: string,
): boolean {
  const expectedCount = expectedSource.filter((id) => id === deliveryId).length;
  const actualCount = actual.filter((id) => id === deliveryId).length;
  return expectedSource.length === expectedCount
    && actual.length === actualCount
    && actualCount === expectedCount;
}

function requireAttempt(
  observation: ZombieInterventionObservation,
  label: InterventionAttemptObservation["label"],
): InterventionAttemptObservation {
  const attempt = observation.attempts.find((candidate) => candidate.label === label);
  if (!attempt) throw new Error(`missing ${label} intervention attempt`);
  return attempt;
}

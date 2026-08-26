export const REVIVAL_LOOP_MUTATIONS = [
  "replace_resume_with_ghost_queue",
  "drop_durable_consumption",
  "suppress_terminal_with_ghost_successor",
] as const;

export type RevivalLoopMutation = (typeof REVIVAL_LOOP_MUTATIONS)[number];

export interface RevivalLoopObservation {
  deliveryId: string;
  route: {
    runningAdmissions: string[];
    autoResumeStarts: string[];
    executionStarts: string[];
    durableConsumptions: string[];
    queuedAfter: string[];
  };
  failure: {
    disposition: "continue_with_accepted_successor" | "stop_on_error";
    status: string;
    terminationReason: string | undefined;
    terminationDetail: string | null | undefined;
  };
  productBoundaryCalls: {
    route: number;
    runningTransition: number;
    autoResume: number;
    executor: number;
    failureRecovery: number;
  };
}

export function revivalLoopViolations(
  observation: RevivalLoopObservation,
): string[] {
  const violations: string[] = [];
  if (observation.route.runningAdmissions.length !== 0) {
    violations.push("runnerless_message_admitted_to_ghost_queue");
  }
  if (!isExactDelivery(observation.route.autoResumeStarts, observation.deliveryId)) {
    violations.push("auto_resume_not_exactly_once");
  }
  if (!isExactDelivery(observation.route.executionStarts, observation.deliveryId)) {
    violations.push("execution_not_started_exactly_once");
  }
  if (!isExactDelivery(observation.route.durableConsumptions, observation.deliveryId)) {
    violations.push("durable_consumption_not_exactly_once");
  }
  if (observation.route.queuedAfter.length !== 0) {
    violations.push("consumed_delivery_left_queued");
  }
  if (
    observation.failure.disposition !== "stop_on_error"
    || observation.failure.status !== "error"
  ) {
    violations.push("unstartable_successor_suppressed_terminal");
  }
  if (
    observation.failure.terminationReason !== "error_aborted"
    || !observation.failure.terminationDetail
  ) {
    violations.push("terminal_evidence_missing");
  }
  for (const [boundary, calls] of Object.entries(observation.productBoundaryCalls)) {
    if (calls < 1 && boundary !== "runningTransition") {
      violations.push(`product_boundary_unreachable:${boundary}`);
    }
  }
  return violations;
}

export function applyRevivalLoopMutation(
  observation: RevivalLoopObservation,
  mutation: RevivalLoopMutation,
): RevivalLoopObservation {
  const mutated = structuredClone(observation);
  if (mutation === "replace_resume_with_ghost_queue") {
    mutated.route.runningAdmissions = [mutated.deliveryId];
    mutated.route.autoResumeStarts = [];
    mutated.route.executionStarts = [];
  } else if (mutation === "drop_durable_consumption") {
    mutated.route.durableConsumptions = [];
  } else {
    mutated.failure.disposition = "continue_with_accepted_successor";
    mutated.failure.status = "running";
    mutated.failure.terminationReason = undefined;
    mutated.failure.terminationDetail = undefined;
  }
  return mutated;
}

function isExactDelivery(actual: string[], deliveryId: string): boolean {
  return actual.length === 1 && actual[0] === deliveryId;
}

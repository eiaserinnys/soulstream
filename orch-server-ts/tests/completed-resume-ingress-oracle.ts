export const COMPLETED_RESUME_MUTATIONS = [
  "drop_orch_admission",
  "drop_node_dispatch",
  "drop_delivery_begin",
  "drop_semantic_input",
  "duplicate_generation",
] as const;

export type CompletedResumeMutation =
  (typeof COMPLETED_RESUME_MUTATIONS)[number];

export interface CompletedResumeDeliveryObservation {
  deliveryId: string;
  state: string;
  aggregateState: string;
  attemptCount: number;
  dispatching: boolean;
  queued: boolean;
  delivered: boolean;
  consumed: boolean;
  lastError: string | null;
}

export interface CompletedResumeObservation {
  label: string;
  clicks: number;
  expectedSessionLoads: number;
  executionDrainBarrierUsed: boolean;
  httpStatuses: number[];
  httpOutcomes: string[];
  orchAdmissions: number;
  nodeCommands: number;
  sessionLoads: number;
  deliveryGets: number;
  deliveryClaims: number;
  deliveryBegins: number;
  autoResumes: number;
  executionStarts: number;
  semanticInputs: number;
  periodicRecoveryScans: number;
  startupRecoveryScans: number;
  deliveries: CompletedResumeDeliveryObservation[];
  hydrationWarnings: string[];
}

export function completedResumeViolations(
  observation: CompletedResumeObservation,
): string[] {
  const violations: string[] = [];
  const expectedClicks = observation.clicks;
  if (
    observation.httpStatuses.length !== expectedClicks
    || observation.httpStatuses.some((status) => status !== 200)
  ) {
    violations.push(`${observation.label}:http_not_successful`);
  }
  if (observation.orchAdmissions !== expectedClicks) {
    violations.push(`${observation.label}:durable_admission_not_exactly_once`);
  }
  if (observation.nodeCommands !== expectedClicks) {
    violations.push(`${observation.label}:node_command_not_exactly_once`);
  }
  if (observation.sessionLoads !== observation.expectedSessionLoads) {
    violations.push(`${observation.label}:unexpected_session_hydration_count`);
  }
  if (
    observation.expectedSessionLoads > 0
    && (
      observation.periodicRecoveryScans !== 1
      || observation.startupRecoveryScans !== 1
    )
  ) {
    violations.push(`${observation.label}:restart_recovery_not_composed`);
  }
  if (observation.deliveryGets !== expectedClicks) {
    violations.push(`${observation.label}:node_delivery_get_not_exactly_once`);
  }
  if (observation.deliveryClaims !== expectedClicks) {
    violations.push(`${observation.label}:node_delivery_claim_not_exactly_once`);
  }
  if (observation.deliveryBegins !== expectedClicks) {
    violations.push(`${observation.label}:node_delivery_begin_not_exactly_once`);
  }
  if (observation.autoResumes !== 1) {
    violations.push(`${observation.label}:auto_resume_not_exactly_once`);
  }
  if (observation.executionStarts !== 1) {
    violations.push(`${observation.label}:execution_start_not_exactly_once`);
  }
  if (observation.semanticInputs !== expectedClicks) {
    violations.push(`${observation.label}:semantic_input_not_exactly_once`);
  }
  if (observation.httpOutcomes.some((outcome) => outcome === "queued")) {
    const stranded = observation.deliveries.some((delivery) =>
      delivery.state === "pending"
      && delivery.aggregateState === "pending"
      && delivery.attemptCount === 0
      && !delivery.dispatching
      && !delivery.queued
      && !delivery.delivered
      && !delivery.consumed
      && delivery.lastError === null,
    );
    if (stranded) {
      violations.push(`${observation.label}:http_200_masked_fresh_pending_delivery`);
    }
  }
  if (observation.deliveries.length !== expectedClicks) {
    violations.push(`${observation.label}:delivery_identity_count_mismatch`);
  }
  if (new Set(observation.deliveries.map((row) => row.deliveryId)).size !== expectedClicks) {
    violations.push(`${observation.label}:delivery_identity_not_unique`);
  }
  return violations;
}

export function applyCompletedResumeMutation(
  observation: CompletedResumeObservation,
  mutation: CompletedResumeMutation,
): CompletedResumeObservation {
  const mutated = structuredClone(observation);
  if (mutation === "drop_orch_admission") {
    mutated.orchAdmissions = 0;
    mutated.deliveries = [];
  } else if (mutation === "drop_node_dispatch") {
    mutated.nodeCommands = 0;
  } else if (mutation === "drop_delivery_begin") {
    mutated.deliveryBegins = 0;
  } else if (mutation === "drop_semantic_input") {
    mutated.semanticInputs = 0;
  } else {
    mutated.executionStarts = 2;
  }
  return mutated;
}

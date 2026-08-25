import type { TaskStatus } from "../../src/task/task_models.js";

export type OracleMutation =
  | "hide_control_timeout"
  | "fake_next_turn_activation"
  | "mask_terminal_error"
  | "collapse_dual_report_producers"
  | "passive_wait_until_natural_complete";

export interface ClaudeInterruptionObservation {
  backend: "claude";
  deliveryId: string;
  terminalStatus: TaskStatus;
  terminalError: string | null;
  interruptRequestDeliveryIds: string[];
  interruptAdmissionDeliveryIds: string[];
  reservedDeliveryIds: string[];
  provenDeliveryIds: string[];
  activatedDeliveryIds: string[];
  modelInputDeliveryIds: string[];
  resultDeliveryIds: string[];
  completeDeliveryIds: string[];
  durableDeliveryIds: string[];
  consumedDeliveryIds: string[];
  naturalForegroundReleases: number;
  eventOrder: string[];
}

export interface ProducerObservation {
  kind: "explicit_report" | "automatic_completion";
  reportIdentity: string;
  deliveryId: string;
}

export interface EObservation {
  controlTimeoutErrors: string[];
  terminalStatus: TaskStatus;
  terminalError: string | null;
  nextTurnReservations: number;
  nextTurnProofs: number;
  nextTurnActivations: number;
  nextTurnModelInputs: number;
  nextTurnResults: number;
  nextTurnCompletes: number;
  reportProducers: ProducerObservation[];
  durableDeliveryIds: string[];
  consumedDeliveryIds: string[];
}

export function contractViolations(
  observation: EObservation,
  timeoutExpectation: "absent" | "present" = "absent",
): string[] {
  const failures: string[] = [];
  if (timeoutExpectation === "absent" && observation.controlTimeoutErrors.length !== 0) {
    failures.push("control_timeout");
  }
  if (timeoutExpectation === "present" && observation.controlTimeoutErrors.length !== 1) {
    failures.push("control_timeout_evidence_missing");
  }
  if (observation.terminalStatus !== "completed") failures.push("parent_not_completed");
  if (observation.terminalError !== null) failures.push("terminal_error");
  if (observation.nextTurnReservations !== 1) failures.push("next_turn_reservation");
  if (observation.nextTurnProofs !== 1) failures.push("next_turn_proof");
  if (observation.nextTurnActivations !== 1) failures.push("next_turn_activation");
  if (observation.nextTurnModelInputs !== 1) failures.push("next_turn_model_input");
  if (observation.nextTurnResults !== 1) failures.push("next_turn_result");
  if (observation.nextTurnCompletes !== 1) failures.push("next_turn_complete");
  const producerKinds = observation.reportProducers.map((producer) => producer.kind).sort();
  if (
    producerKinds.length !== 2
    || producerKinds[0] !== "automatic_completion"
    || producerKinds[1] !== "explicit_report"
  ) {
    failures.push("report_producer_paths");
  }
  const producerIdentities = new Set(
    observation.reportProducers.map((producer) => producer.reportIdentity),
  );
  const producerDeliveryIds = new Set(
    observation.reportProducers.map((producer) => producer.deliveryId),
  );
  if (producerIdentities.size !== 1 || producerDeliveryIds.size !== 1) {
    failures.push("report_identity_diverged");
  }
  const expectedDeliveryId = observation.reportProducers[0]?.deliveryId;
  if (
    expectedDeliveryId === undefined
    || observation.durableDeliveryIds.length !== 1
    || observation.durableDeliveryIds[0] !== expectedDeliveryId
  ) {
    failures.push("durable_delivery_not_exactly_once");
  }
  if (
    expectedDeliveryId === undefined
    || observation.consumedDeliveryIds.length !== 1
    || observation.consumedDeliveryIds[0] !== expectedDeliveryId
  ) {
    failures.push("durable_consume_not_exactly_once");
  }
  return failures;
}

export function applyOracleMutation(
  observation: EObservation,
  mutation: OracleMutation | undefined,
): EObservation {
  if (mutation === "hide_control_timeout") {
    return { ...observation, controlTimeoutErrors: [] };
  }
  if (mutation === "fake_next_turn_activation") {
    return {
      ...observation,
      nextTurnReservations: 1,
      nextTurnProofs: 1,
      nextTurnActivations: 1,
    };
  }
  if (mutation === "mask_terminal_error") {
    return { ...observation, terminalStatus: "completed", terminalError: null };
  }
  if (mutation === "collapse_dual_report_producers") {
    return {
      ...observation,
      reportProducers: observation.reportProducers.slice(0, 1),
    };
  }
  return observation;
}

export function claudeInterruptionViolations(
  observation: ClaudeInterruptionObservation,
): string[] {
  const failures: string[] = [];
  const expectedDelivery = [observation.deliveryId];
  if (observation.terminalStatus !== "completed") failures.push("parent_not_completed");
  if (observation.terminalError !== null) failures.push("terminal_error");
  if (!sameStrings(observation.interruptRequestDeliveryIds, expectedDelivery)) {
    failures.push("interrupt_request_not_exactly_once");
  }
  if (!sameStrings(observation.interruptAdmissionDeliveryIds, expectedDelivery)) {
    failures.push("interrupt_admission_not_exactly_once");
  }
  for (const [name, values] of [
    ["next_turn_reservation", observation.reservedDeliveryIds],
    ["next_turn_proof", observation.provenDeliveryIds],
    ["next_turn_activation", observation.activatedDeliveryIds],
    ["next_turn_model_input", observation.modelInputDeliveryIds],
    ["next_turn_result", observation.resultDeliveryIds],
    ["next_turn_complete", observation.completeDeliveryIds],
    ["durable_delivery", observation.durableDeliveryIds],
    ["durable_consume", observation.consumedDeliveryIds],
  ] as const) {
    if (!sameStrings(values, expectedDelivery)) failures.push(`${name}_not_exactly_once`);
  }
  const orderedEvents = [
    "interrupt_request",
    "interrupt_admission",
    "next_turn_reserved",
    "next_turn_proven",
    "next_turn_activated",
    "next_turn_model_input",
    "next_turn_result",
    "next_turn_complete",
  ];
  const observedPositions = orderedEvents.map((event) => observation.eventOrder.indexOf(event));
  if (
    observedPositions.some((position) => position < 0)
    || observedPositions.some((position, index) => index > 0 && position <= observedPositions[index - 1]!)
  ) {
    failures.push("claude_interrupt_boundary_order");
  }
  const naturalRelease = observation.eventOrder.indexOf("natural_foreground_release");
  const admission = observation.eventOrder.indexOf("interrupt_admission");
  const modelInput = observation.eventOrder.indexOf("next_turn_model_input");
  if (
    admission >= 0
    && naturalRelease > admission
    && modelInput > naturalRelease
  ) {
    failures.push("passive_wait_until_natural_complete");
  } else if (observation.naturalForegroundReleases !== 0 || naturalRelease >= 0) {
    failures.push("natural_foreground_release_observed");
  }
  return failures;
}

export function applyClaudeInterruptionMutation(
  observation: ClaudeInterruptionObservation,
  mutation: OracleMutation | undefined,
): ClaudeInterruptionObservation {
  if (mutation !== "passive_wait_until_natural_complete") return observation;
  const admissionIndex = observation.eventOrder.indexOf("interrupt_admission");
  const eventOrder = observation.eventOrder.filter(
    (event) => event !== "injected_old_execution_ended",
  );
  eventOrder.splice(Math.max(0, admissionIndex + 1), 0, "natural_foreground_release");
  return {
    ...observation,
    naturalForegroundReleases: 1,
    eventOrder,
  };
}

export function idealClaudeInterruptionObservation(
  deliveryId: string,
): ClaudeInterruptionObservation {
  return {
    backend: "claude",
    deliveryId,
    terminalStatus: "completed",
    terminalError: null,
    interruptRequestDeliveryIds: [deliveryId],
    interruptAdmissionDeliveryIds: [deliveryId],
    reservedDeliveryIds: [deliveryId],
    provenDeliveryIds: [deliveryId],
    activatedDeliveryIds: [deliveryId],
    modelInputDeliveryIds: [deliveryId],
    resultDeliveryIds: [deliveryId],
    completeDeliveryIds: [deliveryId],
    durableDeliveryIds: [deliveryId],
    consumedDeliveryIds: [deliveryId],
    naturalForegroundReleases: 0,
    eventOrder: [
      "foreground_running",
      "interrupt_request",
      "interrupt_admission",
      "next_turn_reserved",
      "next_turn_proven",
      "next_turn_activated",
      "next_turn_model_input",
      "next_turn_result",
      "next_turn_complete",
    ],
  };
}

export function readOracleMutation(value: string | undefined): OracleMutation | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    value === "hide_control_timeout"
    || value === "fake_next_turn_activation"
    || value === "mask_terminal_error"
    || value === "collapse_dual_report_producers"
    || value === "passive_wait_until_natural_complete"
  ) return value;
  throw new Error(`Unknown E oracle mutation: ${value}`);
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

export function idealObservation(input: {
  reportIdentity: string;
  deliveryId: string;
}): EObservation {
  return {
    controlTimeoutErrors: [],
    terminalStatus: "completed",
    terminalError: null,
    nextTurnReservations: 1,
    nextTurnProofs: 1,
    nextTurnActivations: 1,
    nextTurnModelInputs: 1,
    nextTurnResults: 1,
    nextTurnCompletes: 1,
    reportProducers: [
      {
        kind: "explicit_report",
        reportIdentity: input.reportIdentity,
        deliveryId: input.deliveryId,
      },
      {
        kind: "automatic_completion",
        reportIdentity: input.reportIdentity,
        deliveryId: input.deliveryId,
      },
    ],
    durableDeliveryIds: [input.deliveryId],
    consumedDeliveryIds: [input.deliveryId],
  };
}

import type { TaskStatus } from "../../src/task/task_models.js";

export type OracleMutation =
  | "hide_control_timeout"
  | "fake_next_turn_activation"
  | "mask_terminal_error"
  | "collapse_dual_report_producers";

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
  nextTurnCompletes: number;
  reportProducers: ProducerObservation[];
  durableDeliveryIds: string[];
  consumedDeliveryIds: string[];
}

export function contractViolations(observation: EObservation): string[] {
  const failures: string[] = [];
  if (observation.controlTimeoutErrors.length !== 0) failures.push("control_timeout");
  if (observation.terminalStatus !== "completed") failures.push("parent_not_completed");
  if (observation.terminalError !== null) failures.push("terminal_error");
  if (observation.nextTurnReservations !== 1) failures.push("next_turn_reservation");
  if (observation.nextTurnProofs !== 1) failures.push("next_turn_proof");
  if (observation.nextTurnActivations !== 1) failures.push("next_turn_activation");
  if (observation.nextTurnModelInputs !== 1) failures.push("next_turn_model_input");
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

export function readOracleMutation(value: string | undefined): OracleMutation | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    value === "hide_control_timeout"
    || value === "fake_next_turn_activation"
    || value === "mask_terminal_error"
    || value === "collapse_dual_report_producers"
  ) return value;
  throw new Error(`Unknown E oracle mutation: ${value}`);
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

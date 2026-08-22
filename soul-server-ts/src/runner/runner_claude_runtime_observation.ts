import {
  attachClaudeBackgroundDeliveryMetadata,
  readClaudeBackgroundDeliveryMetadata,
  type ClaudeBackgroundDeliveryMetadata,
} from "../engine/claude_background_delivery_metadata.js";

import {
  RunnerClaudeRuntimeObservationResultSchema,
  type RunnerClaudeRuntimeObservationResult,
} from "./frame_protocol.js";

export type RunnerClaudeRuntimeObservationIssueReporter = (issue: Error) => void;

export function buildRunnerClaudeRuntimeObservationResult(
  accepted: boolean,
  event: object,
): RunnerClaudeRuntimeObservationResult {
  const delivery = readClaudeBackgroundDeliveryMetadata(event);
  return RunnerClaudeRuntimeObservationResultSchema.parse({
    accepted,
    ...(delivery ? { claudeBackgroundDelivery: delivery } : {}),
  });
}

/**
 * Applies the host-owned lifecycle verdict to the child event that continues
 * through detached publish and the engine-event frame. Boolean responses keep
 * rolling upgrades compatible with hosts from before this semantic contract.
 */
export function applyRunnerClaudeRuntimeObservationResult(
  event: object,
  value: unknown,
  reportIssue: RunnerClaudeRuntimeObservationIssueReporter,
): boolean {
  if (typeof value === "boolean") return value;
  const parsed = RunnerClaudeRuntimeObservationResultSchema.safeParse(value);
  if (!parsed.success) {
    reportIssue(new Error(
      `Runner Claude runtime observation returned an invalid result: ${parsed.error.message}`,
    ));
    return true;
  }
  const result = parsed.data;
  const delivery = result.claudeBackgroundDelivery;
  if (delivery) {
    const existing = readClaudeBackgroundDeliveryMetadata(event);
    if (existing && !sameDelivery(existing, delivery)) {
      reportIssue(new Error(
        `Runner Claude delivery metadata disagreed across host observation ` +
        `for ${delivery.deliveryId}`,
      ));
      // The host lifecycle already owns its durable delivery. Suppress only
      // this conflicting child event so the controller cannot mint a sibling
      // delivery, while keeping the persistent Claude session alive.
      return false;
    }
    if (!existing) attachClaudeBackgroundDeliveryMetadata(event, delivery);
  }
  return result.accepted;
}

function sameDelivery(
  left: ClaudeBackgroundDeliveryMetadata,
  right: ClaudeBackgroundDeliveryMetadata,
): boolean {
  return left.deliveryId === right.deliveryId
    && left.completionId === right.completionId
    && left.relationKey === right.relationKey
    && left.producerTerminalRevision === right.producerTerminalRevision
    && left.deliveryCreatedAt === right.deliveryCreatedAt
    && left.source === right.source
    && left.storedPayloadHash === right.storedPayloadHash;
}

import type { SessionDeliveryRepository } from
  "../db/repositories/session_delivery_repository.js";

import { buildDeterministicDeliveryIdentity } from "./delivery_identity.js";

export interface ChildCompletionObservation {
  childSessionId: string;
  callerSessionId: string;
  terminalRevision: number;
  source: string;
}

export type ChildCompletionObservationResult =
  | "recorded"
  | "not_found"
  | "not_child_caller"
  | "not_terminal"
  | "missing_terminal_revision"
  | "revision_mismatch";

type ChildCompletionRepository = Pick<
  SessionDeliveryRepository,
  "recordObservedChildCompletion"
>;

/**
 * Durable producer for the moment a caller actually observes a child result.
 *
 * The MCP tool must await this write before returning the child summary. A
 * later completion notifier therefore sees the relation tombstone and cannot
 * wake or display the same semantic result again.
 */
export class ChildCompletionConsumptionRecorder {
  constructor(private readonly repository: ChildCompletionRepository) {}

  async recordObserved(
    observation: ChildCompletionObservation,
  ): Promise<ChildCompletionObservationResult> {
    const relationKey = [
      "child_session",
      observation.childSessionId,
      observation.terminalRevision,
    ].join(":");
    const identity = buildDeterministicDeliveryIdentity({
      targetSessionId: observation.callerSessionId,
      relationKey,
      intent: "completion_notification",
    });
    return await this.repository.recordObservedChildCompletion({
      childSessionId: observation.childSessionId,
      observedRevision: observation.terminalRevision,
      relationKey,
      completionId: identity.completionId,
      callerSessionId: observation.callerSessionId,
      consumedTurnId: [
        "mcp",
        observation.source,
        observation.childSessionId,
        observation.terminalRevision,
      ].join(":"),
    });
  }
}

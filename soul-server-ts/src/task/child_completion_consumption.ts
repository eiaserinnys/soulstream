import type { SessionDeliveryRepository } from
  "../db/repositories/session_delivery_repository.js";

import { buildDeterministicDeliveryIdentity } from "./delivery_identity.js";

export interface ChildCompletionObservation {
  childSessionId: string;
  childCallerSessionId: string | null;
  callerSessionId: string;
  status: string | null;
  terminalRevision: string | null;
}

export type ChildCompletionObservationResult =
  | "recorded"
  | "not_child_caller"
  | "not_terminal"
  | "missing_terminal_revision";

type ChildCompletionRepository = Pick<
  SessionDeliveryRepository,
  "recordRelationConsumed"
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
    if (observation.childCallerSessionId !== observation.callerSessionId) {
      return "not_child_caller";
    }
    if (!isTerminalStatus(observation.status)) {
      return "not_terminal";
    }
    if (!observation.terminalRevision) {
      return "missing_terminal_revision";
    }

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
    await this.repository.recordRelationConsumed({
      relationKey,
      completionId: identity.completionId,
      callerSessionId: observation.callerSessionId,
      consumedTurnId: [
        "mcp",
        "get_session_summary",
        observation.childSessionId,
        observation.terminalRevision,
      ].join(":"),
    });
    return "recorded";
  }
}

function isTerminalStatus(
  status: string | null,
): status is "completed" | "error" | "interrupted" {
  return status === "completed" || status === "error" || status === "interrupted";
}

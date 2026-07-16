import type { NodeCommandResponse } from "../node/pending_commands.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";

export type SessionReviewAcknowledgeOutcome =
  | "acknowledged"
  | "already_acknowledged"
  | "not_found"
  | "not_required"
  | "not_pending";

export type SessionReviewAcknowledgeResult = {
  readonly outcome: SessionReviewAcknowledgeOutcome;
  readonly session: Record<string, unknown> | null;
};

export type SessionReviewAcknowledgeRepository = {
  acknowledgeSessionReview: (
    sessionId: string,
  ) => Promise<SessionReviewAcknowledgeResult>;
};

export type SessionReviewAcknowledgeFallback = {
  acknowledgeSessionReview: (sessionId: string) => Promise<NodeCommandResponse>;
};

export type CreateSessionReviewAcknowledgeFallbackOptions = {
  readonly repository: SessionReviewAcknowledgeRepository;
  readonly broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>;
};

export function createSessionReviewAcknowledgeFallback(
  options: CreateSessionReviewAcknowledgeFallbackOptions,
): SessionReviewAcknowledgeFallback {
  return {
    async acknowledgeSessionReview(sessionId) {
      const result = await options.repository.acknowledgeSessionReview(sessionId);
      if (
        result.outcome === "acknowledged" ||
        result.outcome === "already_acknowledged"
      ) {
        if (result.session === null) {
          throw new Error(
            `Durably acknowledged session is missing from DB: ${sessionId}`,
          );
        }

        // The DB stored procedure owns the durable transition. Do not repair the
        // node registry here: a revived node must hydrate the acknowledged state
        // from DB, while this event only refreshes dashboard/catalog projections.
        options.broadcaster.append({
          type: "session_updated",
          ...result.session,
          agent_session_id: sessionId,
        });
        return {
          type: "acknowledge_session_review_ack",
          status: "ok",
          agentSessionId: sessionId,
          reviewState: "acknowledged",
          changed: result.outcome === "acknowledged",
        };
      }

      return {
        type: "acknowledge_session_review_ack",
        status: "error",
        agentSessionId: sessionId,
        code: reviewOutcomeErrorCode(result.outcome),
        message: reviewOutcomeMessage(result.outcome),
      };
    },
  };
}

function reviewOutcomeErrorCode(
  outcome: Exclude<
    SessionReviewAcknowledgeOutcome,
    "acknowledged" | "already_acknowledged"
  >,
): string {
  if (outcome === "not_found") return "SESSION_NOT_FOUND";
  if (outcome === "not_required") return "REVIEW_NOT_REQUIRED";
  return "REVIEW_NOT_PENDING";
}

function reviewOutcomeMessage(
  outcome: Exclude<
    SessionReviewAcknowledgeOutcome,
    "acknowledged" | "already_acknowledged"
  >,
): string {
  if (outcome === "not_found") return "Session not found";
  if (outcome === "not_required") return "Session review is not required";
  return "Session review is not pending";
}

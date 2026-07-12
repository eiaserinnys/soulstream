import type { CallerInfo, ReviewState } from "./task_models.js";

const HUMAN_OWNED_SOURCES = new Set(["slack", "browser", "soul-app"]);

export interface InitialSessionReview {
  reviewRequired: boolean;
  reviewState: ReviewState;
}

export function initialSessionReview(
  callerInfo: Pick<CallerInfo, "source"> | undefined,
): InitialSessionReview {
  return {
    reviewRequired:
      typeof callerInfo?.source === "string" &&
      HUMAN_OWNED_SOURCES.has(callerInfo.source),
    reviewState: "not_required",
  };
}

export function reviewStateAfterTerminal(reviewRequired: boolean): ReviewState {
  return reviewRequired ? "needs_review" : "not_required";
}

export function reviewStateAfterFollowup(reviewState: ReviewState): ReviewState {
  return reviewState === "needs_review" ? "acknowledged" : reviewState;
}

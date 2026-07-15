import type { CallerInfo, ReviewState } from "./task_models.js";

const USER_SOURCES = new Set(["slack", "soul-app"]);
const BROWSER_IDENTITY_FIELDS = ["user_id", "email", "display_name"] as const;

export interface InitialSessionReview {
  reviewRequired: boolean;
  reviewState: ReviewState;
}

export function initialSessionReview(
  callerInfo: CallerInfo | undefined,
): InitialSessionReview {
  return {
    reviewRequired: isUserInitiatedSession(callerInfo),
    reviewState: "not_required",
  };
}

/**
 * 사용자 직접 이니시에이션 판별 정본.
 *
 * 인증 없는 자동 HTTP 호출도 orch 경계에서 telemetry-only `browser` caller로
 * 조립될 수 있으므로 source만으로 사람이라고 판단하지 않는다. 부모 세션이나
 * 생성 경로를 재귀 추적하지 않고 현재 세션의 직접 caller_info만 본다.
 */
export function isUserInitiatedSession(
  callerInfo: CallerInfo | undefined,
): boolean {
  if (!callerInfo || typeof callerInfo.source !== "string") return false;
  const source = callerInfo.source;
  if (USER_SOURCES.has(source)) return true;
  if (source !== "browser") return false;
  return BROWSER_IDENTITY_FIELDS.some((field) =>
    hasNonBlankString(callerInfo[field]),
  );
}

export function reviewStateAfterTerminal(reviewRequired: boolean): ReviewState {
  return reviewRequired ? "needs_review" : "acknowledged";
}

export function reviewStateAfterFollowup(reviewState: ReviewState): ReviewState {
  return reviewState === "needs_review" ? "acknowledged" : reviewState;
}

function hasNonBlankString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

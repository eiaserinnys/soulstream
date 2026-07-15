import type { SessionSummary } from "@seosoyoung/soul-ui";

import { singleLinePreview } from "./session-preview";

export const REVIEW_NAV_LIMIT = 5;
export const REVIEW_PREVIEW_LENGTH = 120;

export function reviewQueueSessions(
  sessions: readonly SessionSummary[],
): SessionSummary[] {
  return sessions
    .filter((session) => session.reviewState === "needs_review")
    .sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left)
      || right.agentSessionId.localeCompare(left.agentSessionId));
}

export function reviewNavigationSessions(
  sessions: readonly SessionSummary[],
): SessionSummary[] {
  return reviewQueueSessions(sessions).slice(0, REVIEW_NAV_LIMIT);
}

export function reviewSessionTitle(session: SessionSummary): string {
  const title = (session as SessionSummary & { title?: string }).title;
  return singleLinePreview(session.displayName, REVIEW_PREVIEW_LENGTH)
    ?? singleLinePreview(title, REVIEW_PREVIEW_LENGTH)
    ?? singleLinePreview(session.prompt, REVIEW_PREVIEW_LENGTH)
    ?? session.agentSessionId;
}

export function reviewSessionPreview(session: SessionSummary): string {
  return singleLinePreview(
    session.awaySummary ?? session.lastMessage?.preview ?? session.prompt,
    REVIEW_PREVIEW_LENGTH,
  ) ?? "완료된 세션이 검수를 기다리고 있습니다.";
}

function sessionTimestamp(session: SessionSummary): number {
  for (const value of [session.updatedAt, session.completedAt, session.createdAt]) {
    const parsed = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

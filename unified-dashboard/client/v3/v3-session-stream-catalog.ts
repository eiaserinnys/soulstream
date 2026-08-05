import {
  retainEqualValue,
  toSessionSummary,
  type CatalogState,
  type SessionListStreamEvent,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

export function projectSessionListSnapshot(
  catalog: CatalogState,
  event: SessionListStreamEvent,
): CatalogState {
  const incoming = event.sessions.map(normalizeSnapshotSession);
  const incomingIds = new Set(incoming.map((session) => session.agentSessionId));
  const offWindowReviews = (catalog.sessionList ?? []).filter((session) => (
    session.reviewState === "needs_review" &&
    !incomingIds.has(session.agentSessionId)
  ));
  const sessionList = retainEqualValue(
    catalog.sessionList,
    [...incoming, ...offWindowReviews],
  );
  return sessionList === catalog.sessionList
    ? catalog
    : { ...catalog, sessionList };
}

/**
 * `reviewSessions` is the complete server-filtered membership snapshot.
 * Keep unrelated recent rows, replace matching reviews, and remove review rows
 * that the server no longer reports.
 */
export function reconcileCanonicalReviewSessions(
  catalog: CatalogState,
  reviewSessions: readonly SessionSummary[],
): CatalogState {
  const reviewsById = new Map(
    reviewSessions.map((session) => [session.agentSessionId, session]),
  );
  const includedReviewIds = new Set<string>();
  const nextSessionList: SessionSummary[] = [];

  for (const current of catalog.sessionList ?? []) {
    const review = reviewsById.get(current.agentSessionId);
    if (review) {
      includedReviewIds.add(current.agentSessionId);
      nextSessionList.push(review);
      continue;
    }
    if (current.reviewState !== "needs_review") nextSessionList.push(current);
  }

  for (const review of reviewSessions) {
    if (!includedReviewIds.has(review.agentSessionId)) nextSessionList.push(review);
  }

  const sessionList = retainEqualValue(catalog.sessionList, nextSessionList);
  return sessionList === catalog.sessionList
    ? catalog
    : { ...catalog, sessionList };
}

function normalizeSnapshotSession(session: SessionSummary): SessionSummary {
  if (typeof session.agentSessionId === "string") return session;
  return toSessionSummary(session as unknown as Record<string, unknown>);
}

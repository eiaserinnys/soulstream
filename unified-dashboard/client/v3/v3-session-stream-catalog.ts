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
  const sessionList = retainEqualValue(
    catalog.sessionList,
    event.sessions.map(normalizeSnapshotSession),
  );
  return sessionList === catalog.sessionList
    ? catalog
    : { ...catalog, sessionList };
}

function normalizeSnapshotSession(session: SessionSummary): SessionSummary {
  if (typeof session.agentSessionId === "string") return session;
  return toSessionSummary(session as unknown as Record<string, unknown>);
}

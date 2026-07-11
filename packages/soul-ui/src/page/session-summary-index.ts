import type { SessionSummary } from "../shared/types";

export type SessionSummaryIndex = ReadonlyMap<string, SessionSummary>;

export type SessionReferenceResolution =
  | { kind: "ready"; sessionId: string; summary: SessionSummary }
  | { kind: "unavailable"; sessionId: string; message: string };

export function createSessionSummaryIndex(
  sessions: readonly SessionSummary[],
): SessionSummaryIndex {
  return new Map(sessions.map((session) => [session.agentSessionId, session]));
}

export function resolveSessionReference(
  index: SessionSummaryIndex,
  sessionId: string,
): SessionReferenceResolution {
  const summary = index.get(sessionId);
  if (summary) return { kind: "ready", sessionId, summary };
  return {
    kind: "unavailable",
    sessionId,
    message: "Session unavailable — it may have been deleted or you may not have access.",
  };
}

import type { SessionSummary } from "@seosoyoung/soul-ui";

export function resolveActiveSessionSummary(
  activeSessionKey: string | null,
  activeSessionSummary: SessionSummary | null | undefined,
  visibleSessions: SessionSummary[],
): SessionSummary | undefined {
  if (!activeSessionKey) return undefined;
  if (activeSessionSummary?.agentSessionId === activeSessionKey) {
    return activeSessionSummary;
  }
  return visibleSessions.find((s) => s.agentSessionId === activeSessionKey);
}

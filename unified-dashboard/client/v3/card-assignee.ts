import type { SessionSummary } from "@seosoyoung/soul-ui";

const indexes = new WeakMap<readonly SessionSummary[], ReadonlyMap<string, SessionSummary>>();

export function cardAssignee(sessions: readonly SessionSummary[] | undefined, id: string | null | undefined): SessionSummary | undefined {
  if (!sessions || !id) return undefined;
  let index = indexes.get(sessions);
  if (!index) {
    const byId = new Map<string, SessionSummary>();
    for (const session of sessions) if (!byId.has(session.agentSessionId)) byId.set(session.agentSessionId, session);
    index = byId;
    indexes.set(sessions, index);
  }
  return index.get(id);
}

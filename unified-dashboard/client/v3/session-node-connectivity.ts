import type { SessionNodeConnectivity } from "@seosoyoung/soul-ui/lib/session-node-connectivity";
import type { SessionSummary } from "@seosoyoung/soul-ui";

export type SessionPresentationStatus = SessionSummary["status"] | "offline";

export function sessionPresentationStatus(
  session: SessionSummary,
  connectivity: SessionNodeConnectivity,
): SessionPresentationStatus {
  if (
    session.status === "running"
    && connectivity.ready
    && session.nodeId
    && !connectivity.connectedNodeIds.has(session.nodeId)
  ) {
    return "offline";
  }
  return session.status;
}

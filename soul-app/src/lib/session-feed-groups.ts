import type { Session } from '../api/types';
import {
  projectVisibleSessions,
  type SessionNodeConnectivity,
} from './session-node-projection';
import { sessionNeedsReview } from './session-review';

export interface SessionFeedGroups {
  attention: Session[];
  running: Session[];
  review: Session[];
}

export function classifySessionFeed(
  sessions: readonly Session[],
  connectivity: SessionNodeConnectivity,
): SessionFeedGroups {
  const visible = projectVisibleSessions(sessions, connectivity);
  const groups: SessionFeedGroups = { attention: [], running: [], review: [] };
  const classifiedSessionIds = new Set<string>();

  for (const session of visible) {
    if (classifiedSessionIds.has(session.agentSessionId)) continue;
    if ((session.pendingAttentions?.length ?? 0) > 0) {
      groups.attention.push(session);
      classifiedSessionIds.add(session.agentSessionId);
    } else if (session.status === 'running') {
      groups.running.push(session);
      classifiedSessionIds.add(session.agentSessionId);
    } else if (sessionNeedsReview(session)) {
      groups.review.push(session);
      classifiedSessionIds.add(session.agentSessionId);
    }
  }

  return groups;
}

import type { Session } from '../api/types';

export interface SessionNodeConnectivity {
  ready: boolean;
  connectedNodeIds: ReadonlySet<string>;
}

export function normalizeNodeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function isSessionOnDisconnectedNode(
  session: Pick<Session, 'status' | 'nodeId'>,
  connectivity: SessionNodeConnectivity,
): boolean {
  if (!connectivity.ready || session.status !== 'running') return false;
  const nodeId = normalizeNodeId(session.nodeId);
  return nodeId !== null && !connectivity.connectedNodeIds.has(nodeId);
}

export function projectVisibleSessions<T extends Pick<Session, 'status' | 'nodeId'>>(
  sessions: readonly T[],
  connectivity: SessionNodeConnectivity,
): T[] {
  return sessions.filter((session) => !isSessionOnDisconnectedNode(session, connectivity));
}

import type { Session } from '../api/types';

export interface PlannerSessionTreeRow {
  session: Session;
  depth: number;
}

/**
 * 웹 v3 buildRunTree와 같은 callerSessionId 기반 업무 세션 트리다.
 * predecessorSessionId는 "이어서 시작"의 맥락일 뿐 위임 부모 관계가 아니다.
 */
export function buildPlannerSessionTreeRows(
  sessions: readonly Session[],
): PlannerSessionTreeRow[] {
  const unique: Session[] = [];
  const seenIds = new Set<string>();
  for (const session of sessions) {
    if (seenIds.has(session.agentSessionId)) continue;
    seenIds.add(session.agentSessionId);
    unique.push(session);
  }

  const byId = new Map(unique.map((session) => [session.agentSessionId, session]));
  const inputOrder = new Map(unique.map((session, index) => [session.agentSessionId, index]));
  const compareNewest = (left: Session, right: Session) => (
    sessionTimestamp(right) - sessionTimestamp(left)
    || (inputOrder.get(left.agentSessionId) ?? 0) - (inputOrder.get(right.agentSessionId) ?? 0)
  );
  const roots = unique.filter((session) => {
    const parentId = session.callerSessionId;
    return !parentId
      || !byId.has(parentId)
      || callerChainReturnsTo(session.agentSessionId, byId);
  }).sort(compareNewest);
  const rootIds = new Set(roots.map((session) => session.agentSessionId));
  const childrenByParent = new Map<string, Session[]>();

  for (const session of unique) {
    const parentId = session.callerSessionId;
    if (!parentId || rootIds.has(session.agentSessionId) || !byId.has(parentId)) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(session);
    childrenByParent.set(parentId, children);
  }
  for (const children of childrenByParent.values()) children.sort(compareNewest);

  const rows: PlannerSessionTreeRow[] = [];
  const rendered = new Set<string>();
  const append = (session: Session, depth: number) => {
    if (rendered.has(session.agentSessionId)) return;
    rendered.add(session.agentSessionId);
    rows.push({ session, depth });
    for (const child of childrenByParent.get(session.agentSessionId) ?? []) {
      append(child, depth + 1);
    }
  };
  for (const root of roots) append(root, 0);

  // 손상된 입력에서도 누락은 허용하지 않는다. 정상 관계에서는 이 경로에 도달하지 않는다.
  for (const session of [...unique].sort(compareNewest)) append(session, 0);
  return rows;
}

function callerChainReturnsTo(
  startId: string,
  byId: ReadonlyMap<string, Session>,
): boolean {
  const visited = new Set<string>();
  let currentId = byId.get(startId)?.callerSessionId;
  while (currentId && byId.has(currentId)) {
    if (currentId === startId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    currentId = byId.get(currentId)?.callerSessionId;
  }
  return false;
}

function sessionTimestamp(session: Session): number {
  const updated = Date.parse(session.updatedAt ?? '');
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(session.createdAt ?? '');
  return Number.isFinite(created) ? created : 0;
}

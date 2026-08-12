import type { InfiniteData } from "@tanstack/react-query";

import type { SessionSummary } from "../shared/types";

interface SessionPage {
  sessions: SessionSummary[];
  total: number;
}

function sessionSnapshotTime(session: SessionSummary): number | null {
  const timestamp = session.updatedAt ?? session.createdAt;
  if (timestamp === undefined) return null;
  const parsed = new Date(timestamp).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function sessionSnapshotRevision(session: SessionSummary): number | null {
  const revision = session.lastEventId;
  return typeof revision === "number" && Number.isFinite(revision) && revision >= 0
    ? revision
    : null;
}

function shouldReplaceSessionSnapshot(
  current: SessionSummary,
  incoming: SessionSummary,
): boolean {
  const currentTime = sessionSnapshotTime(current);
  const incomingTime = sessionSnapshotTime(incoming);
  if (
    currentTime !== null
    && incomingTime !== null
    && currentTime !== incomingTime
  ) {
    return incomingTime > currentTime;
  }

  // Orch session snapshots expose lastEventId from the per-session monotonic
  // last_event_id. If either revision is unavailable (or tied), arrival order is
  // the only remaining evidence, so the later payload intentionally wins.
  const currentRevision = sessionSnapshotRevision(current);
  const incomingRevision = sessionSnapshotRevision(incoming);
  if (
    currentRevision !== null
    && incomingRevision !== null
    && currentRevision !== incomingRevision
  ) {
    return incomingRevision > currentRevision;
  }
  return true;
}

/**
 * 같은 세션의 페이지/캐시 스냅샷이 잠시 겹쳐도 표시 계층에는 한 개만 넘긴다.
 * updatedAt/createdAt이 더 최신인 스냅샷을 선택한다. 시각이 동률이거나 비교 불가하면
 * lastEventId를 사용하고, 그것도 비교 불가하면 나중 도착한 스냅샷을 선택한다.
 */
export function dedupeSessionSnapshots(
  sessions: readonly SessionSummary[],
): SessionSummary[] {
  const indexes = new Map<string, number>();
  const unique: SessionSummary[] = [];

  for (const session of sessions) {
    const index = indexes.get(session.agentSessionId);
    if (index === undefined) {
      indexes.set(session.agentSessionId, unique.length);
      unique.push(session);
      continue;
    }

    if (shouldReplaceSessionSnapshot(unique[index], session)) {
      unique[index] = session;
    }
  }

  return unique;
}

export type SessionLifecycleSnapshot = Pick<
  SessionSummary,
  "agentSessionId" | "status" | "reviewState"
>;

/**
 * Initial session_list는 REST 목록을 대체하지 않고 lifecycle 필드만 보정한다.
 * 일치하는 세션과 그 페이지만 복제하여 광역 refetch 없이 구조 공유를 유지한다.
 */
export function applySessionLifecycleSnapshot(
  data: InfiniteData<SessionPage>,
  snapshots: ReadonlyMap<string, SessionLifecycleSnapshot>,
): InfiniteData<SessionPage> {
  let dataChanged = false;
  const pages = data.pages.map((page) => {
    const sessions = applySessionLifecycleSnapshotToList(
      page.sessions,
      snapshots,
    );
    if (sessions === page.sessions) return page;
    dataChanged = true;
    return { ...page, sessions };
  });
  return dataChanged ? { ...data, pages } : data;
}

export function applySessionLifecycleSnapshotToList(
  sessions: SessionSummary[],
  snapshots: ReadonlyMap<string, SessionLifecycleSnapshot>,
): SessionSummary[] {
  let changed = false;
  const next = sessions.map((session) => {
    const snapshot = snapshots.get(session.agentSessionId);
    if (
      snapshot === undefined
      || (
        snapshot.status === session.status
        && snapshot.reviewState === session.reviewState
      )
    ) {
      return session;
    }
    changed = true;
    return {
      ...session,
      status: snapshot.status,
      reviewState: snapshot.reviewState,
    };
  });
  return changed ? next : sessions;
}

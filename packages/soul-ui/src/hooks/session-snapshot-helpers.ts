import type { InfiniteData } from "@tanstack/react-query";

import type { SessionSummary } from "../shared/types";
import { retainEqualValue } from "../lib/structural-sharing";
import { feedLastEventIdPatch } from "./session-feed-projection";

interface SessionPage {
  sessions: SessionSummary[];
  total: number;
}

type SessionSnapshotFreshness = Pick<
  SessionSummary,
  "updatedAt" | "createdAt" | "lastEventId"
>;

function sessionSnapshotTime(session: SessionSnapshotFreshness): number | null {
  const timestamp = session.updatedAt ?? session.createdAt;
  if (timestamp === undefined) return null;
  const parsed = new Date(timestamp).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function sessionSnapshotRevision(session: SessionSnapshotFreshness): number | null {
  const revision = session.lastEventId;
  return typeof revision === "number" && Number.isFinite(revision) && revision >= 0
    ? revision
    : null;
}

function shouldReplaceSessionSnapshot(
  current: SessionSnapshotFreshness,
  incoming: SessionSnapshotFreshness,
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

function nonNegativeRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function sessionFeedHydrationPatch(
  current: SessionSummary,
  snapshot: SessionSummary,
): Partial<SessionSummary> {
  const patch: Partial<SessionSummary> = {};
  const currentAttentionRevision = nonNegativeRevision(current.attentionRevision);
  const incomingAttentionRevision = nonNegativeRevision(snapshot.attentionRevision);
  if (
    incomingAttentionRevision !== null
    && snapshot.pendingAttentions !== undefined
    && (currentAttentionRevision === null || incomingAttentionRevision >= currentAttentionRevision)
  ) {
    const pendingAttentions = retainEqualValue(
      current.pendingAttentions,
      snapshot.pendingAttentions,
    );
    if (pendingAttentions !== current.pendingAttentions) {
      patch.pendingAttentions = pendingAttentions;
    }
    if (incomingAttentionRevision !== currentAttentionRevision) {
      patch.attentionRevision = incomingAttentionRevision;
    }
  }

  const currentNoticeWatermark = nonNegativeRevision(current.notificationWatermark);
  const incomingNoticeWatermark = nonNegativeRevision(snapshot.notificationWatermark);
  if (
    incomingNoticeWatermark !== null
    && snapshot.recentNotices !== undefined
    && (currentNoticeWatermark === null || incomingNoticeWatermark >= currentNoticeWatermark)
  ) {
    const recentNotices = retainEqualValue(current.recentNotices, snapshot.recentNotices);
    if (recentNotices !== current.recentNotices) {
      patch.recentNotices = recentNotices;
    }
    if (incomingNoticeWatermark !== currentNoticeWatermark) {
      patch.notificationWatermark = incomingNoticeWatermark;
    }
    if (
      snapshot.noticesTruncated !== undefined
      && snapshot.noticesTruncated !== current.noticesTruncated
    ) {
      patch.noticesTruncated = snapshot.noticesTruncated;
    }
  }
  return patch;
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

/**
 * session_list 요약을 기존 query 페이지에 공통 규칙으로 병합한다.
 * 목록 membership은 유지하고, 일치하는 행의 최신 full summary만 반영한다.
 */
export function applySessionSummarySnapshot(
  data: InfiniteData<SessionPage>,
  snapshots: ReadonlyMap<string, SessionSummary>,
): InfiniteData<SessionPage> {
  let dataChanged = false;
  const pages = data.pages.map((page) => {
    const sessions = applySessionSummarySnapshotToList(
      page.sessions,
      snapshots,
    );
    if (sessions === page.sessions) return page;
    dataChanged = true;
    return { ...page, sessions };
  });
  return dataChanged ? { ...data, pages } : data;
}

export function applySessionSummarySnapshotToList(
  sessions: SessionSummary[],
  snapshots: ReadonlyMap<string, SessionSummary>,
): SessionSummary[] {
  let changed = false;
  const next = sessions.map((session) => {
    const snapshot = snapshots.get(session.agentSessionId);
    if (snapshot === undefined) return session;
    const merged = mergeSessionSummarySnapshot(session, snapshot);
    if (merged === session) return session;
    changed = true;
    return merged;
  });
  return changed ? next : sessions;
}

/**
 * Apply a full summary snapshot only when its lifecycle revision is current.
 * Omitted optional fields stay intact; attention, notice, and feed watermarks
 * retain their own monotonic revision rules.
 */
export function mergeSessionSummarySnapshot(
  current: SessionSummary,
  incoming: SessionSummary,
): SessionSummary {
  const replaceSnapshot = shouldReplaceSessionSnapshot(current, incoming);
  const definedIncoming = Object.fromEntries(
    Object.entries(incoming).filter(([key, value]) => (
      value !== undefined
      && key !== "feedLastEventId"
      && key !== "pendingAttentions"
      && key !== "attentionRevision"
      && key !== "recentNotices"
      && key !== "notificationWatermark"
      && key !== "noticesTruncated"
    )),
  ) as Partial<SessionSummary>;
  const feedPatch = feedLastEventIdPatch(current, incoming);
  const hydrationPatch = sessionFeedHydrationPatch(current, incoming);
  if (!replaceSnapshot && Object.keys(feedPatch).length === 0 && Object.keys(hydrationPatch).length === 0) {
    return current;
  }
  return retainEqualValue(current, {
    ...current,
    ...(replaceSnapshot ? definedIncoming : {}),
    ...feedPatch,
    ...hydrationPatch,
  });
}

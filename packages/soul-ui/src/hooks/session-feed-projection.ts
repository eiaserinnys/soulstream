import type { PendingAttention, SessionNotice, SessionSummary } from "../shared/types";
import type { SessionUpdatedStreamEvent } from "../shared/stream-events";

const MAX_LOCAL_NOTICES = 50;
const MAX_NOTICE_SESSION_BASELINES = 500;

function storeNoticeBaseline(
  baselines: Map<string, NoticeBaseline>,
  sessionId: string,
  baseline: NoticeBaseline,
): void {
  baselines.delete(sessionId);
  baselines.set(sessionId, baseline);
  while (baselines.size > MAX_NOTICE_SESSION_BASELINES) {
    const oldest = baselines.keys().next().value;
    if (oldest === undefined) break;
    baselines.delete(oldest);
  }
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function matchingAttention(
  value: PendingAttention,
  sessionId: string,
  id: string,
): boolean {
  return value.sessionId === sessionId && value.id === id;
}

function matchingNotice(value: SessionNotice, sessionId: string): boolean {
  return value.sessionId === sessionId
    && value.id === `${sessionId}:${value.sourceEventId}`
    && Number.isFinite(value.sourceEventId)
    && value.sourceEventId >= 0;
}

/**
 * Applies one durable feed delta to one session snapshot. A single global
 * revision is sufficient because hydration is authoritative at that watermark;
 * the global revision also retains tombstone ordering between later deltas.
 */
export function applySessionFeedDelta(
  current: SessionSummary,
  event: SessionUpdatedStreamEvent,
): Partial<SessionSummary> {
  if (current.agentSessionId !== event.agent_session_id) return {};

  const patch: Partial<SessionSummary> = {};
  const currentGlobalRevision = finiteNonNegative(current.attentionRevision);
  const incomingGlobalRevision = finiteNonNegative(event.attention_revision);
  const delta = event.pending_attentions_delta;

  if (delta && incomingGlobalRevision > currentGlobalRevision) {
    const byId = new Map(
      (current.pendingAttentions ?? [])
        .filter((value) => value.sessionId === current.agentSessionId)
        .map((value) => [value.id, value]),
    );
    for (const [id, entry] of Object.entries(delta)) {
      const revision = finiteNonNegative(entry.revision);
      if (revision <= currentGlobalRevision || revision > incomingGlobalRevision) continue;
      if (entry.value === null) {
        byId.delete(id);
      } else if (matchingAttention(entry.value, current.agentSessionId, id)) {
        byId.set(id, entry.value);
      }
    }

    patch.pendingAttentions = [...byId.values()].sort(
      (a, b) => b.sourceEventId - a.sourceEventId || a.id.localeCompare(b.id),
    );
    patch.attentionRevision = incomingGlobalRevision;
  }

  const notices = (event.notices ?? []).filter((notice) =>
    matchingNotice(notice, current.agentSessionId),
  );
  const incomingNoticeWatermark = Math.max(
    finiteNonNegative(event.notification_watermark),
    ...notices.map((notice) => finiteNonNegative(notice.sourceEventId)),
  );
  if (notices.length > 0 || incomingNoticeWatermark > finiteNonNegative(current.notificationWatermark)) {
    const journal = new Map(
      (current.recentNotices ?? [])
        .filter((notice) => matchingNotice(notice, current.agentSessionId))
        .map((notice) => [notice.id, notice]),
    );
    for (const notice of notices) journal.set(notice.id, notice);
    patch.recentNotices = [...journal.values()]
      .sort((a, b) => b.sourceEventId - a.sourceEventId || a.id.localeCompare(b.id))
      .slice(0, MAX_LOCAL_NOTICES);
    patch.notificationWatermark = Math.max(
      finiteNonNegative(current.notificationWatermark),
      incomingNoticeWatermark,
    );
  }

  return patch;
}

export interface NoticeBaseline {
  watermark: number;
  ids: Set<string>;
}

/** Hydration is baseline-only, including ring-gap/truncated snapshots. */
export function hydrateNoticeBaseline(
  baselines: Map<string, NoticeBaseline>,
  session: SessionSummary,
): void {
  storeNoticeBaseline(baselines, session.agentSessionId, {
    watermark: finiteNonNegative(session.notificationWatermark),
    ids: new Set((session.recentNotices ?? []).map((notice) => notice.id)),
  });
}

/** Returns only unseen live notices and advances the bounded local baseline. */
export function takeLiveSessionNotices(
  baselines: Map<string, NoticeBaseline>,
  event: SessionUpdatedStreamEvent,
): SessionNotice[] {
  const baseline = baselines.get(event.agent_session_id) ?? {
    watermark: 0,
    ids: new Set<string>(),
  };
  const result: SessionNotice[] = [];
  const notices = (event.notices ?? [])
    .filter((notice) => matchingNotice(notice, event.agent_session_id))
    .sort((a, b) => a.sourceEventId - b.sourceEventId);

  for (const notice of notices) {
    if (notice.sourceEventId <= baseline.watermark || baseline.ids.has(notice.id)) continue;
    baseline.ids.add(notice.id);
    result.push(notice);
  }
  baseline.watermark = Math.max(
    baseline.watermark,
    finiteNonNegative(event.notification_watermark),
    ...notices.map((notice) => notice.sourceEventId),
  );
  if (baseline.ids.size > MAX_LOCAL_NOTICES * 2) {
    baseline.ids = new Set(notices.slice(-MAX_LOCAL_NOTICES).map((notice) => notice.id));
  }
  storeNoticeBaseline(baselines, event.agent_session_id, baseline);
  return result;
}

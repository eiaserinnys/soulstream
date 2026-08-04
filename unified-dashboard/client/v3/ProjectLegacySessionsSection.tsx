import type { SessionSummary } from "@seosoyoung/soul-ui";
import { DashboardIconCap } from "@seosoyoung/soul-ui";
import { ChevronsDown } from "lucide-react";

import { RichSessionRow } from "./RichSessionRow";
import {
  sessionPresentationStatus,
  type SessionNodeConnectivity,
} from "./session-node-connectivity";
import { V3ErrorNotice } from "./V3ErrorNotice";

export function ProjectLegacySessionsSection({
  sessions,
  liveSessions,
  nodeConnectivity,
  loading,
  loadingMore,
  error,
  hasMore,
  onLoadMore,
  onOpenSession,
}: {
  sessions: readonly SessionSummary[];
  liveSessions: readonly SessionSummary[];
  nodeConnectivity: SessionNodeConnectivity;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore(): void;
  onOpenSession(session: SessionSummary): void;
}) {
  const liveById = new Map(liveSessions.map((session) => [session.agentSessionId, session]));
  const visibleSessions = sessions.map((session) => liveById.get(session.agentSessionId) ?? session);
  return (
    <section className="v3-project-legacy-sessions">
      <div className="v3-section-head">
        <h2>레가시 세션</h2><span>{sessions.length}개{hasMore ? "+" : ""}</span>
      </div>
      {loading ? <div className="v3-empty" aria-busy="true">레가시 세션을 불러오는 중…</div> : null}
      {error ? <V3ErrorNotice message="레가시 세션을 불러오지 못했습니다." detail={error} /> : null}
      <div className="v3-run-list">
        {visibleSessions.map((session) => (
          <RichSessionRow
            key={session.agentSessionId}
            session={session}
            nodeOffline={sessionPresentationStatus(session, nodeConnectivity) === "offline"}
            onOpen={onOpenSession}
          />
        ))}
      </div>
      {!loading && !error && sessions.length === 0 ? (
        <div className="v3-empty">이 프로젝트에 레가시 세션이 없습니다.</div>
      ) : null}
      {hasMore ? (
        <DashboardIconCap
          label="이전 레가시 세션 더 보기"
          data-testid="v3-load-more-project-legacy-sessions"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          <ChevronsDown className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      ) : null}
    </section>
  );
}

import type { MouseEvent, ReactNode } from "react";
import { ProfileAvatar, type SessionSummary } from "@seosoyoung/soul-ui";

import { reviewSessionTitle } from "./review-queue-model";
import { singleLinePreview } from "./session-preview";
import "./v3-run-history.css";

export function RichSessionRow({
  session,
  runNumber = null,
  failed = false,
  preview,
  actions,
  onOpen,
  onContextMenu,
}: {
  session: SessionSummary;
  runNumber?: number | null;
  failed?: boolean;
  preview?: string;
  actions?: ReactNode;
  onOpen(session: SessionSummary): void;
  onContextMenu?(session: SessionSummary, event: MouseEvent<HTMLDivElement>): void;
}) {
  const title = failed ? runNumberLabel(runNumber) : reviewSessionTitle(session);
  const status = failed ? "조회 실패" : statusLabel(session.status);
  const portraitUrl = failed ? null : sessionPortraitUrl(session);
  const visiblePreview = failed
    ? "세션 정보를 불러오지 못했습니다."
    : preview ?? singleLinePreview(
      session.lastMessage?.preview ?? session.prompt,
      120,
    ) ?? "아직 표시할 메시지가 없습니다.";

  return (
    <div
      className={`v3-run-row${failed ? " v3-run-row--failed" : ""}`}
      data-load-state={failed ? "failed" : "ready"}
      data-session-id={failed ? undefined : session.agentSessionId}
      onContextMenu={failed || !onContextMenu ? undefined : (event) => onContextMenu(session, event)}
    >
      <button type="button" className="v3-run-open" disabled={failed} onClick={() => onOpen(session)}>
        <span className="v3-run-avatar">
          <ProfileAvatar role="assistant" hasPortrait={Boolean(portraitUrl)} portraitUrl={portraitUrl} fallbackEmoji="🤖" />
        </span>
        <span className="v3-run-copy">
          <span className="v3-run-title-line">
            <strong>{title}</strong>
            {!failed && runNumber !== null ? <span className="v3-run-number">세션 #{runNumber}</span> : null}
          </span>
          <span className="v3-run-agent-line">
            <span>{failed ? "세션 상세 없음" : session.agentName ?? session.agentId ?? "에이전트 미상"}</span>
            {!failed ? <span>{session.nodeId ?? "노드 미상"}</span> : null}
          </span>
          <small>{visiblePreview}</small>
        </span>
        <span className="v3-run-trailing">
          <span className={`v3-run-status-badge v3-run-status-badge--${failed ? "failed" : session.status}`}>
            <span className={`v3-run-status v3-run-status--${failed ? "error" : session.status}`} aria-hidden="true" />
            {status}
          </span>
          <time>{failed ? "" : formatRelativeSessionTime(session)}</time>
        </span>
      </button>
      {actions ? <div className="v3-run-row-actions">{actions}</div> : null}
    </div>
  );
}

function sessionPortraitUrl(session: SessionSummary): string | null {
  if (session.agentPortraitUrl) return session.agentPortraitUrl;
  if (!session.nodeId || !session.agentId) return null;
  return `/api/nodes/${encodeURIComponent(session.nodeId)}/agents/${encodeURIComponent(session.agentId)}/portrait`;
}

function statusLabel(status: SessionSummary["status"]): string {
  if (status === "running") return "실행 중";
  if (status === "completed") return "완료";
  if (status === "error") return "오류";
  if (status === "interrupted") return "중단";
  return "대기";
}

function runNumberLabel(runNumber: number | null): string {
  return runNumber === null ? "세션" : `세션 #${runNumber}`;
}

function formatRelativeSessionTime(session: SessionSummary): string {
  const value = session.lastMessage?.timestamp
    ?? session.completedAt
    ?? session.updatedAt
    ?? session.createdAt;
  if (!value) return "시각 미상";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "시각 미상";
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "방금 전";
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.round(hours / 24)}일 전`;
}

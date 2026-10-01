import type { MouseEvent } from "react";
import {
  getSessionActivityTimestamp,
  ProfileAvatar,
  STATUS_CONFIG,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { RunRowFrame, type RunRowAction } from "./RunRowFrame";

import { singleLinePreview } from "./session-preview";
import { sessionPanelTitle } from "./v3-session-panel-model";
import "./v3-run-history.css";

export function RichSessionRow({
  session,
  runNumber = null,
  failed = false,
  nodeOffline = false,
  active = false,
  affiliation,
  preview,
  actions,
  onOpen,
  size = "default",
  onContextMenu,
}: {
  session: SessionSummary;
  size?: "default" | "small";
  runNumber?: number | null;
  failed?: boolean;
  nodeOffline?: boolean;
  active?: boolean;
  affiliation?: string | null;
  preview?: string;
  actions?: readonly RunRowAction[];
  onOpen(session: SessionSummary): void;
  onContextMenu?(session: SessionSummary, event: MouseEvent<HTMLDivElement>): void;
}) {
  const title = failed ? runNumberLabel(runNumber) : sessionPanelTitle(session);
  const status = failed
    ? "조회 실패"
    : nodeOffline
      ? "노드 오프라인"
      : (STATUS_CONFIG[session.status] ?? STATUS_CONFIG.unknown).label;
  const presentationStatus = failed ? "failed" : nodeOffline ? "offline" : session.status;
  const modelLabel = failed ? null : sessionModelLabel(session);
  const portraitUrl = failed ? null : sessionPortraitUrl(session);
  const visiblePreview = failed
    ? "세션 정보를 불러오지 못했습니다."
    : preview ?? singleLinePreview(
      session.lastMessage?.preview ?? session.prompt,
      120,
    ) ?? "아직 표시할 메시지가 없습니다.";

  return <RunRowFrame
    size={size}
    active={active} failed={failed} offline={nodeOffline}
    sessionId={failed ? undefined : session.agentSessionId}
    onContextMenu={failed || !onContextMenu ? undefined : event=>onContextMenu(session,event)}
    disabled={failed} onOpen={()=>onOpen(session)}
    avatar={<ProfileAvatar role="assistant" hasPortrait={Boolean(portraitUrl)} portraitUrl={portraitUrl} fallbackEmoji="🤖"/>}
    title={<><strong>{title}</strong>{!failed && runNumber!==null ? <span className="v3-run-number">세션 #{runNumber}</span>:null}</>}
    agentLine={<><span>{failed ? "세션 상세 없음":session.agentName??session.agentId??"에이전트 미상"}</span>{size==="small"&&!failed?<span>{session.nodeId??"노드 미상"}</span>:null}{modelLabel?<span title={modelLabel}>{modelLabel}</span>:null}{size!=="small"&&!failed?<span>{session.nodeId??"노드 미상"}</span>:null}</>}
    affiliation={affiliation?<span className="v3-run-affiliation" title={affiliation}>{affiliation}</span>:null}
    preview={visiblePreview}
    status={{label:`세션 ${status}`,tone:presentationStatus}}
    timestamp={failed?undefined:{display:formatRelativeSessionTime(session),raw:getSessionActivityTimestamp(session)??undefined}}
    actions={actions}
  />;
}

export function sessionModelLabel(
  session: Pick<SessionSummary, "modelLabel" | "backend">,
): string | null {
  const explicitLabel = session.modelLabel?.trim();
  if (explicitLabel) return explicitLabel;
  const backend = session.backend?.trim();
  if (!backend) return null;
  return backend
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sessionPortraitUrl(session: SessionSummary): string | null {
  if (session.agentPortraitUrl) return session.agentPortraitUrl;
  if (!session.nodeId || !session.agentId) return null;
  return `/api/nodes/${encodeURIComponent(session.nodeId)}/agents/${encodeURIComponent(session.agentId)}/portrait`;
}

function runNumberLabel(runNumber: number | null): string {
  return runNumber === null ? "세션" : `세션 #${runNumber}`;
}

function formatRelativeSessionTime(session: SessionSummary): string {
  const value = getSessionActivityTimestamp(session);
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

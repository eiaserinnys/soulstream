import type { ReactNode } from "react";
import {
  DashboardIconCap, SessionModelPresetBadge, SessionStoryDisclosure, STATUS_CONFIG,
  type SessionProviderConnectionStatus, type SessionSummary,
} from "@seosoyoung/soul-ui";
import { ArrowLeft, X } from "lucide-react";
import { FolderTitleEditor } from "./FolderTitleEditor";
import { SessionStreamStatus } from "./SessionStreamStatus";
import { sessionPanelTitle } from "./v3-session-panel-model";

/** Operational headers and their review samples share markup and boundary insets. */
export function FolderPanelHeader({ title, onRename, backLabel, onBack, inline, status, actions }: {
  title: string; onRename(title: string): Promise<void>;
  backLabel: string; onBack(): void; inline?: boolean;
  status?: { value: string; icon: ReactNode; label: string }; actions: ReactNode;
}) {
  return <header className={`v3-panel-header v3-folder-header${inline ? " v3-inline-folder-header" : " v3-workspace-toolbar"}`}>
    <DashboardIconCap label={backLabel} onClick={onBack}><ArrowLeft className="h-4 w-4" aria-hidden="true"/></DashboardIconCap>
    {status ? <span className={`v3-status-chip v3-status-chip--${status.value}`}>{status.icon} {status.label}</span> : null}
    <FolderTitleEditor title={title} onRename={onRename} headingLevel={1}/>
    <div className="v3-folder-header-actions">{actions}</div>
  </header>;
}

export function SessionPanelHeader({ session, emptyTitle = "선택된 세션 없음", streamActive, connectionStatus, reconnect, onClose }: {
  session: SessionSummary | undefined; emptyTitle?: string;
  streamActive: boolean; connectionStatus: SessionProviderConnectionStatus;
  reconnect(): void; onClose?(): void;
}) {
  return <header className="v3-panel-header v3-chat-header">
    <div className="v3-chat-session-title"><strong>{session ? sessionPanelTitle(session) : emptyTitle}</strong></div>
    <SessionModelPresetBadge session={session}/>
    <span className={`v3-chat-status v3-chat-status--${session?.status ?? "unknown"}`}>
      {session ? (STATUS_CONFIG[session.status] ?? STATUS_CONFIG.unknown).label : STATUS_CONFIG.unknown.label}
    </span>
    {session ? <SessionStreamStatus active={streamActive} status={connectionStatus} reconnect={reconnect}/> : null}
    {session ? <SessionStoryDisclosure sessionId={session.agentSessionId}/> : null}
    {onClose ? <DashboardIconCap label="채팅 닫기" onClick={onClose}><X className="h-4 w-4" aria-hidden="true"/></DashboardIconCap> : null}
  </header>;
}

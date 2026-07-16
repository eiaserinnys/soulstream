import {
  forwardRef,
  memo,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import {
  SessionContextMenu,
  SessionReviewAcknowledgeError,
  acknowledgeSessionReview,
  useGlassSurface,
  type SessionContextMenuState,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

import { sessionPanelGroups, sessionPanelTitle } from "./v3-session-panel-model";
import { RichSessionRow } from "./RichSessionRow";
import "./v3-session-panel.css";

interface V3SessionPanelProps {
  sessions: readonly SessionSummary[];
  activeSessionId: string | null;
  onOpenSession(session: SessionSummary): void;
  onRenameSession(sessionId: string, displayName: string | null): Promise<void>;
  onDeleteSessions(sessionIds: string[]): Promise<void>;
  onAcknowledged(result: SessionReviewAcknowledgeResult): void;
}

export const V3SessionPanel = forwardRef<HTMLElement, V3SessionPanelProps>(function V3SessionPanel({
  sessions,
  activeSessionId,
  onOpenSession,
  onRenameSession,
  onDeleteSessions,
  onAcknowledged,
}, forwardedRef) {
  const surfaceRef = useRef<HTMLElement>(null);
  const pendingRef = useRef(false);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });
  const groups = useMemo(() => sessionPanelGroups(sessions), [sessions]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
  useImperativeHandle(forwardedRef, () => surfaceRef.current as HTMLElement);

  const openContextMenu = (session: SessionSummary, event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      sessionId: session.agentSessionId,
    });
  };

  const acknowledge = async (session: SessionSummary) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPendingId(session.agentSessionId);
    setError(null);
    try {
      onAcknowledged(await acknowledgeSessionReview(session.agentSessionId));
    } catch (caught) {
      setError(reviewErrorMessage(caught));
    } finally {
      pendingRef.current = false;
      setPendingId(null);
    }
  };

  return (
    <aside
      ref={surfaceRef}
      className="v3-session-panel border border-glass-border glass-strong glass-chrome lg-rim"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
      data-testid="v3-session-panel"
      aria-label="세션"
      tabIndex={-1}
    >
      <div className="v3-session-panel-scroll">
        <SessionGroup
          title="실행 중"
          testId="v3-session-group-running"
          emptyText="실행 중인 세션이 없습니다."
          sessions={groups.running}
          activeSessionId={activeSessionId}
          pendingId={pendingId}
          onOpenSession={onOpenSession}
          onContextMenu={openContextMenu}
          onAcknowledge={acknowledge}
        />
        <SessionGroup
          title="검수 대기"
          testId="v3-session-group-review"
          emptyText="검수 대기 세션이 없습니다."
          sessions={groups.review}
          activeSessionId={activeSessionId}
          pendingId={pendingId}
          onOpenSession={onOpenSession}
          onContextMenu={openContextMenu}
          onAcknowledge={acknowledge}
          review
        />
        {error ? <p className="v3-session-panel-error" role="alert">{error}</p> : null}
      </div>
      <SessionContextMenu
        contextMenu={contextMenu}
        onClose={() => setContextMenu(null)}
        onRenameSession={onRenameSession}
        onDeleteSessions={onDeleteSessions}
        getSessionName={(sessionId) => sessions.find((session) => session.agentSessionId === sessionId)?.displayName ?? ""}
        resolveSessionIds={(sessionId) => [sessionId]}
      />
    </aside>
  );
});

function SessionGroup({
  title,
  testId,
  emptyText,
  sessions,
  activeSessionId,
  pendingId,
  onOpenSession,
  onContextMenu,
  onAcknowledge,
  review = false,
}: {
  title: string;
  testId: string;
  emptyText: string;
  sessions: readonly SessionSummary[];
  activeSessionId: string | null;
  pendingId: string | null;
  onOpenSession(session: SessionSummary): void;
  onContextMenu(session: SessionSummary, event: MouseEvent<HTMLElement>): void;
  onAcknowledge(session: SessionSummary): Promise<void>;
  review?: boolean;
}) {
  return (
    <section className="v3-session-group" data-testid={testId}>
      <header><h2>{title}</h2><span>{sessions.length}</span></header>
      <div className="v3-session-list">
        {sessions.map((session) => (
          <SessionPanelRow
            key={session.agentSessionId}
            session={session}
            active={activeSessionId === session.agentSessionId}
            pending={pendingId === session.agentSessionId}
            review={review}
            onOpenSession={onOpenSession}
            onContextMenu={onContextMenu}
            onAcknowledge={onAcknowledge}
          />
        ))}
        {sessions.length === 0 ? <p>{emptyText}</p> : null}
      </div>
    </section>
  );
}

const SessionPanelRow = memo(function SessionPanelRow({
  session,
  active,
  pending,
  review,
  onOpenSession,
  onContextMenu,
  onAcknowledge,
}: {
  session: SessionSummary;
  active: boolean;
  pending: boolean;
  review: boolean;
  onOpenSession(session: SessionSummary): void;
  onContextMenu(session: SessionSummary, event: MouseEvent<HTMLElement>): void;
  onAcknowledge(session: SessionSummary): Promise<void>;
}) {
  return (
    <div
      className={`v3-session-row${active ? " is-active" : ""}`}
      data-testid={`v3-session-row-${session.agentSessionId}`}
    >
      <RichSessionRow
        session={session}
        onOpen={onOpenSession}
        onContextMenu={onContextMenu}
        actions={review ? (
          <button
            type="button"
            className="v3-session-acknowledge"
            disabled={pending}
            aria-label={`${sessionPanelTitle(session)} 확인 처리`}
            onClick={() => { void onAcknowledge(session); }}
          >
            {pending ? "…" : "확인"}
          </button>
        ) : undefined}
      />
    </div>
  );
});

function reviewErrorMessage(error: unknown): string {
  if (error instanceof SessionReviewAcknowledgeError) {
    if (error.status === 404) return "세션을 찾을 수 없습니다. 목록을 새로 고쳐주세요.";
    if (error.status === 409) return "검수 상태가 바뀌었습니다. 목록을 새로 고쳐주세요.";
    return `검수 확인 실패: ${error.detail}`;
  }
  return "서버에 연결할 수 없습니다. 잠시 뒤 다시 시도하세요.";
}

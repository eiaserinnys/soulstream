import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { CardRow } from "./CardRow";
import { useShallow } from "zustand/react/shallow";
import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  useSessionMenu,
  acknowledgeSessionReview,
  useGlassSurface,
  type SessionReviewAcknowledgeResult,
  type CatalogFolder,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

import {
  sessionPanelAffiliation,
  sessionPanelGroups,
  sessionPanelTitle,
} from "./v3-session-panel-model";
import { RichSessionRow } from "./RichSessionRow";
import type { SessionNodeConnectivity } from "@seosoyoung/soul-ui/lib/session-node-connectivity";
import { reviewErrorMessage } from "./V3SessionReviewBanner";

interface V3SessionPanelProps {
  sessions: readonly SessionSummary[];
  folders: readonly CatalogFolder[];
  nodeConnectivity: SessionNodeConnectivity;
  activeSessionId: string | null;
  acknowledgedReviewIds?: ReadonlySet<string>;
  onOpenSession(session: SessionSummary): void;
  onAcknowledged(result: SessionReviewAcknowledgeResult): void;
}

export const V3SessionPanel = forwardRef<HTMLElement, V3SessionPanelProps>(function V3SessionPanel({
  sessions,
  folders,
  nodeConnectivity,
  activeSessionId,
  acknowledgedReviewIds = new Set(),
  onOpenSession,
  onAcknowledged,
}, forwardedRef) {
  const reviewCardIds = useCardStore(useShallow(s=>Object.values(s.byId).filter(card=>card.status==="review"&&!card.archived).map(card=>card.id)));
  const cardTitles = useCardStore(useShallow(s=>sessions.map(session=>session.cardId ? s.byId[session.cardId]?.title : undefined)));
  const surfaceRef = useRef<HTMLElement>(null);
  const pendingRef = useRef(false);
  const webglActive = useGlassSurface(surfaceRef, { enabled: true });
  const groups = useMemo(
    () => sessionPanelGroups(sessions, nodeConnectivity, acknowledgedReviewIds),
    [acknowledgedReviewIds, nodeConnectivity, sessions],
  );
  const affiliations = useMemo(() => new Map(sessions.map((session, index) => [
    session.agentSessionId,
    cardTitles[index] ?? sessionPanelAffiliation(folders, session.folderId),
   ])), [folders, sessions, cardTitles]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openSessionMenu = useSessionMenu();
  useImperativeHandle(forwardedRef, () => surfaceRef.current as HTMLElement);

  const openContextMenu = useCallback((session: SessionSummary, event: MouseEvent<HTMLElement>) => {
    openSessionMenu(session.agentSessionId,event);
  }, [openSessionMenu]);

  const acknowledge = useCallback(async (session: SessionSummary) => {
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
  }, [onAcknowledged]);

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
          affiliations={affiliations}
          activeSessionId={activeSessionId}
          pendingId={pendingId}
          onOpenSession={onOpenSession}
          onContextMenu={openContextMenu}
          onAcknowledge={acknowledge}
        />
        {groups.offline.length > 0 ? (
          <SessionGroup
            title="노드 오프라인"
            testId="v3-session-group-offline"
            emptyText=""
            sessions={groups.offline}
            affiliations={affiliations}
            activeSessionId={activeSessionId}
            pendingId={pendingId}
            onOpenSession={onOpenSession}
            onContextMenu={openContextMenu}
            onAcknowledge={acknowledge}
            nodeOffline
          />
        ) : null}
        <SessionGroup
          title="검수 대기"
          testId="v3-session-group-review"
          emptyText="검수 대기 세션이 없습니다."
          sessions={groups.review}
          affiliations={affiliations}
          activeSessionId={activeSessionId}
          pendingId={pendingId}
          onOpenSession={onOpenSession}
          onContextMenu={openContextMenu}
          onAcknowledge={acknowledge}
          review
          extraCount={reviewCardIds.length}
          children={reviewCardIds.map(id=><ReviewCardRow key={id} id={id} folders={folders}/>)}
        />
        {error ? <p className="v3-session-panel-error" role="alert">{error}</p> : null}
      </div>

    </aside>
  );
});

const ReviewCardRow = memo(function ReviewCardRow({id,folders}:{id:string;folders:readonly CatalogFolder[]}) {
  const card=useCardStore(state=>state.byId[id]);
  return card ? <CardRow card={card} folders={folders}/> : null;
});

function SessionGroup({
  title,
  testId,
  emptyText,
  sessions,
  affiliations,
  activeSessionId,
  pendingId,
  onOpenSession,
  onContextMenu,
  onAcknowledge,
  review = false,
  nodeOffline = false,
  children, extraCount = 0,
}: {
  title: string;
  testId: string;
  emptyText: string;
  sessions: readonly SessionSummary[];
  affiliations: ReadonlyMap<string, string | null>;
  activeSessionId: string | null;
  pendingId: string | null;
  onOpenSession(session: SessionSummary): void;
  onContextMenu(session: SessionSummary, event: MouseEvent<HTMLElement>): void;
  onAcknowledge(session: SessionSummary): Promise<void>;
  review?: boolean;
  nodeOffline?: boolean;
  children?: ReactNode; extraCount?: number;
}) {
  return (
    <section className="v3-session-group" data-testid={testId}>
      <header><h2>{title}</h2><span>{sessions.length+extraCount}</span></header>
      <div className="v3-session-list">
        {sessions.map((session) => (
          <SessionPanelRow
            key={session.agentSessionId}
            session={session}
            affiliation={affiliations.get(session.agentSessionId) ?? null}
            active={activeSessionId === session.agentSessionId}
            pending={pendingId === session.agentSessionId}
            review={review}
            nodeOffline={nodeOffline}
            onOpenSession={onOpenSession}
            onContextMenu={onContextMenu}
            onAcknowledge={onAcknowledge}
          />
        ))}
        {children}
        {sessions.length === 0 && extraCount === 0 ? <p>{emptyText}</p> : null}
      </div>
    </section>
  );
}

const SessionPanelRow = memo(function SessionPanelRow({
  session,
  affiliation,
  active,
  pending,
  review,
  nodeOffline,
  onOpenSession,
  onContextMenu,
  onAcknowledge,
}: {
  session: SessionSummary;
  affiliation: string | null;
  active: boolean;
  pending: boolean;
  review: boolean;
  nodeOffline: boolean;
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
        active={active}
        affiliation={affiliation}
        nodeOffline={nodeOffline}
        onOpen={onOpenSession}
        onContextMenu={onContextMenu}
        actions={review ? [{kind:"acknowledge",label:`${sessionPanelTitle(session)} 확인 처리`,pending,onAction:()=>{void onAcknowledge(session);}}] : undefined}
      />
    </div>
  );
});

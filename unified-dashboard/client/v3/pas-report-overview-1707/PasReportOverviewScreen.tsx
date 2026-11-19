import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { ChevronLeft, ChevronRight, ListTodo, Maximize2, X } from "lucide-react";
import {
  ChatInput,
  DashboardIconCap,
  PersistentSessionPortraitIcon,
  PersistentSessionPortraitOffIcon,
  SwayCharacter,
  useIsMobile,
} from "@seosoyoung/soul-ui";
import { ChatMessageItem } from "@seosoyoung/soul-ui/components/chat/ChatMessageItem";
import { useChatTypography } from "@seosoyoung/soul-ui/components/chat/useChatTypography";
import type { ChatMessage } from "@seosoyoung/soul-ui/lib/flatten-tree";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";

import { PersistentSessionTaskList } from "../PersistentSessionTaskList";
import { StatusChip } from "../StatusChip";
import { V3GlobalToolbar } from "../V3GlobalToolbar";
import { usePersistentSessionGeometry } from "../use-persistent-session-geometry";
import "../persistent-report.css";
import "../persistent-session-screen.css";
import "./v3-pas-report-overview-1707.css";

import {
  HOLD_COUNT,
  MOCK_SESSION_ID,
  type OverviewChatTurn,
  type OverviewScenario,
  overviewStatusLabel,
} from "./pas-report-overview-1707-data";

function toChatMessage(turn: OverviewChatTurn): ChatMessage {
  return {
    id: turn.id,
    role: turn.role,
    content: turn.text,
    treeNodeId: turn.id,
    treeNodeType: turn.role,
  } as ChatMessage;
}

function ReportBubble({
  card, index, total, body, rect, onPrev, onNext, onOpen, openButtonRef,
}: {
  card: OverviewScenario;
  index: number;
  total: number;
  body: { left: number; top: number } | null;
  rect: { left: number; bottom: number; width: number; maxHeight: number; tailLeft: number; tailDirection: "left" | "right" } | null;
  onPrev(): void;
  onNext(): void;
  onOpen(): void;
  openButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const bubbleStyle: CSSProperties | undefined = rect && body ? {
    position: "absolute",
    left: rect.left - body.left,
    top: rect.bottom - body.top,
    width: rect.width,
    maxHeight: rect.maxHeight,
    transform: "translateY(-100%)",
    "--pas-report-tail-left": `${rect.tailLeft}px`,
  } as CSSProperties : undefined;

  return <section className="pas-report pas-ro1707-bubble" data-bubble={rect ? "true" : undefined}
    data-testid="report-bubble" style={bubbleStyle} aria-label="보고 요약">
    <div className="pas-report-sheet">
      <div className="pas-report-reading">
        <div className="pas-report-content">
          <div className="pas-report-heading">
            <div className="pas-report-heading-main">
              <span className="pas-report-card">#{card.number}</span>
              <StatusChip label={overviewStatusLabel(card)} tone={card.status === "blocked" ? "question" : card.status} />
              <h2 className="pas-report-title">
                <button type="button" className="pas-report-expand" onClick={onOpen}>{card.title}</button>
              </h2>
            </div>
            <DashboardIconCap appearance="bare" size="small" label="보고 창 크게 열기" onClick={onOpen}>
              <Maximize2 className="size-4" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
            </DashboardIconCap>
          </div>
          <p className="pas-report-context">{card.request}</p>
        </div>
      </div>
      <div className="pas-report-footer">
        <div className="pas-report-actions">
          <button ref={openButtonRef} type="button" className="pas-ro1707-open-overview" onClick={onOpen}>보고 창 열기</button>
        </div>
      </div>
    </div>
    <div className="pas-report-nav">
      <DashboardIconCap appearance="bare" size="small" label="앞 장 보고" disabled={total < 2} onClick={onPrev}>
        <ChevronLeft className="size-4" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
      </DashboardIconCap>
      <span className="pas-report-count" data-testid="report-bubble-count">{index} / {total}</span>
      <DashboardIconCap appearance="bare" size="small" label="다음 장 보고" disabled={total < 2} onClick={onNext}>
        <ChevronRight className="size-4" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
      </DashboardIconCap>
    </div>
    {rect ? <i className="pas-report-tail" data-direction={rect.tailDirection} aria-hidden="true" /> : null}
  </section>;
}

export function PasReportOverviewScreen({
  card, pendingCards, chatLog, taskCards, openTriggerRef, taskToggleRef, onPrev, onNext, onOpenOverview, onOpenCard, children,
}: {
  card: OverviewScenario;
  pendingCards: readonly OverviewScenario[];
  chatLog: readonly OverviewChatTurn[];
  taskCards: readonly CardRow[];
  openTriggerRef: RefObject<HTMLButtonElement | null>;
  taskToggleRef: RefObject<HTMLButtonElement | null>;
  onPrev(): void;
  onNext(): void;
  onOpenOverview(): void;
  onOpenCard(cardId: string): void;
  children?: ReactNode;
}) {
  const appRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const composerAnchorRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const [showCharacter, setShowCharacter] = useState(true);
  const [tasksOpen, setTasksOpen] = useState(false);
  const isMobile = useIsMobile();
  const { chatTypographyStyle } = useChatTypography();
  const geometry = usePersistentSessionGeometry({
    app: appRef,
    header: headerRef,
    main: mainRef,
    composer: composerAnchorRef,
    enabled: true,
    showCharacter,
  });
  const bubbleRect = geometry?.reportBubble ?? null;
  const bubbleBody = geometry?.body ?? null;
  const pendingIndex = Math.max(0, pendingCards.findIndex(item => item.id === card.id));
  const bubble = pendingCards.length > 0
    ? <ReportBubble card={card} index={pendingIndex + 1} total={pendingCards.length} body={bubbleBody} rect={bubbleRect}
        onPrev={onPrev} onNext={onNext} onOpen={onOpenOverview} openButtonRef={openTriggerRef} />
    : null;

  useLayoutEffect(() => {
    const element = chatScrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [chatLog.length]);

  const closeTasks = () => {
    setTasksOpen(false);
    window.requestAnimationFrame(() => taskToggleRef.current?.focus({ preventScroll: true }));
  };

  return <div ref={appRef} className="v3-shell persistent-session-screen pas-ro1707-screen" data-testid="pas-report-overview-screen">
    <V3GlobalToolbar headerRef={headerRef} variant="minimal" appearance="bare" sessionName="서소영 영구 세션"
      agentName="서소영" agentOnly={isMobile} showHome={!isMobile} onOpenHome={() => {}} onOpenConfig={() => {}} />
    <main ref={mainRef} className="persistent-session-main">
      {bubble && !bubbleRect ? <div className="pas-ro1707-inline-bubble">{bubble}</div> : null}
      <div data-slot="chat-root" data-chat-presentation="manuscript" data-testid="chat-view" className="pas-ro1707-chat">
        <div ref={chatScrollRef} className="pas-ro1707-chat-scroll" role="log" aria-label="영구 세션 대화" style={chatTypographyStyle}>
          {chatLog.map(turn => <div className="pas-ro1707-chat-turn" data-role={turn.role} key={turn.id}>
            <div className="pas-ro1707-chat-meta">
              <span>{turn.role === "assistant" ? "서소영" : "나"}</span>
              <time>{turn.time}</time>
            </div>
            <ChatMessageItem msg={toChatMessage(turn)} sessionId={MOCK_SESSION_ID} presentation="manuscript" />
          </div>)}
        </div>
        <ChatInput presentation="manuscript" composerAnchorRef={composerAnchorRef} />
      </div>
    </main>
    {!tasksOpen && <div className="persistent-session-task-toggle">
      <DashboardIconCap ref={taskToggleRef} appearance="bare" label="작업 목록" aria-expanded={tasksOpen} onClick={() => setTasksOpen(true)}>
        <ListTodo className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
      </DashboardIconCap>
    </div>}
    {tasksOpen && <aside className="persistent-session-tasks pas-ro1707-tasks" aria-label="작업">
      <div className="persistent-session-task-head">
        <h2>작업</h2>
        <DashboardIconCap appearance="bare" label="작업 목록 닫기" onClick={closeTasks}>
          <X className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
        </DashboardIconCap>
      </div>
      <div className="persistent-session-task-scroll">
        <PersistentSessionTaskList cards={[...taskCards]} onOpenCard={cardId => { setTasksOpen(false); onOpenCard(cardId); }} />
      </div>
      <p className="pas-ro1707-hold">보류함 {HOLD_COUNT}개 (변동 없음)</p>
    </aside>}
    {geometry?.body && geometry.lineLeftReach > 0 ? <div aria-hidden="true" className="persistent-session-line"
      style={{ top: geometry.lineY, left: geometry.mainLeft - geometry.lineLeftReach, width: geometry.lineLeftReach }} /> : null}
    {geometry?.body ? <div data-testid="persistent-character" className="persistent-session-character"
      style={{ left: geometry.body.left, top: geometry.body.top, width: geometry.body.width, height: geometry.body.height }}>
      <SwayCharacter shown width={geometry.body.width} height={geometry.body.height} motionEnabled active={!tasksOpen}
        assetBaseUrl="/characters/seosoyoung" />
      {bubble && bubbleRect ? bubble : null}
    </div> : null}
    {geometry?.toggle ? <div className="persistent-session-character-toggle"
      style={{ left: geometry.toggle.left + geometry.toggle.width / 2, top: geometry.toggle.top + geometry.toggle.height / 2 }}>
      <DashboardIconCap appearance="bare" label={showCharacter ? "캐릭터 숨기기" : "캐릭터 표시"} onClick={() => setShowCharacter(value => !value)}>
        {showCharacter ? <PersistentSessionPortraitOffIcon /> : <PersistentSessionPortraitIcon />}
      </DashboardIconCap>
    </div> : null}
    {children}
  </div>;
}
